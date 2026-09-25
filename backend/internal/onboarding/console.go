package onboarding

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"gopkg.in/yaml.v3"
)

const (
	DefaultTailLines    = 500
	MaxTailLines        = 5000
	MaxSinceSeconds     = 7 * 24 * 60 * 60
	MaxLogFilterLength  = 256
	DefaultRevisionPage = 20
	MaxRevisionPage     = 100
)

var (
	// commitSHAPattern accepts abbreviated and full lowercase hex commit ids.
	commitSHAPattern = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
	// resourceNamePattern is a Kubernetes DNS subdomain, which object names
	// such as Pods and ReplicaSets use.
	resourceNamePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
	kindPattern         = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,62}$`)
	uidPattern          = regexp.MustCompile(`^[0-9A-Fa-f-]{1,64}$`)
)

// logKinds lists what Logs accepts, keyed by lowercase kind so a caller's
// casing does not matter.
var logKinds = func() map[string]string {
	kinds := map[string]string{"pod": "Pod"}
	for kind := range workloadGroups {
		kinds[strings.ToLower(kind)] = kind
	}
	return kinds
}()

func validResourceName(value string) bool {
	return len(value) <= 253 && resourceNamePattern.MatchString(value)
}

// ValidCommitSHA reports whether sha is safe to put in a GitHub URL.
func ValidCommitSHA(sha string) bool {
	return commitSHAPattern.MatchString(sha)
}

func validateLogQuery(query *LogQuery) error {
	kind, ok := logKinds[strings.ToLower(query.Resource.Kind)]
	if !ok {
		return ValidationError{
			Message: "logs are available for Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, and Jobs",
		}
	}
	query.Resource.Kind = kind
	if !validResourceName(query.Resource.Name) {
		return ValidationError{Message: "name must be a Kubernetes resource name"}
	}
	if query.Resource.Namespace != "" && !validDNSLabel(query.Resource.Namespace) {
		return ValidationError{Message: "namespace must be a lowercase DNS label"}
	}
	if query.Container != "" && !validDNSLabel(query.Container) {
		return ValidationError{Message: "container must be a lowercase DNS label"}
	}
	if query.TailLines == 0 {
		query.TailLines = DefaultTailLines
	}
	if query.TailLines < 1 || query.TailLines > MaxTailLines {
		return ValidationError{Message: fmt.Sprintf("tailLines must be between 1 and %d", MaxTailLines)}
	}
	if query.SinceSeconds < 0 || query.SinceSeconds > MaxSinceSeconds {
		return ValidationError{Message: fmt.Sprintf("sinceSeconds must be between 1 and %d", MaxSinceSeconds)}
	}
	if query.SinceSeconds > 0 && query.SinceTime != nil {
		return ValidationError{Message: "use either sinceSeconds or sinceTime, not both"}
	}
	if len(query.Filter) > MaxLogFilterLength {
		return ValidationError{Message: fmt.Sprintf("filter must not exceed %d characters", MaxLogFilterLength)}
	}
	if strings.ContainsAny(query.Filter, "\r\n") {
		return ValidationError{Message: "filter must be a single line"}
	}
	return nil
}

func validateEventQuery(query EventQuery) error {
	if query.Kind != "" && !kindPattern.MatchString(query.Kind) {
		return ValidationError{Message: "kind must be a Kubernetes kind"}
	}
	if query.Name != "" && !validResourceName(query.Name) {
		return ValidationError{Message: "name must be a Kubernetes resource name"}
	}
	if query.Namespace != "" && !validDNSLabel(query.Namespace) {
		return ValidationError{Message: "namespace must be a lowercase DNS label"}
	}
	if query.UID != "" && !uidPattern.MatchString(query.UID) {
		return ValidationError{Message: "uid must be a Kubernetes object uid"}
	}
	return nil
}

// Logs streams container logs for a Pod or every Pod of a workload. Unlike
// short reads, the caller's context bounds the stream so it stays open until
// the viewer closes.
func (s *Service) Logs(
	ctx context.Context,
	onboardingID, targetID string,
	query LogQuery,
) (io.ReadCloser, error) {
	if err := validateLogQuery(&query); err != nil {
		return nil, err
	}
	target, client, err := s.target(ctx, onboardingID, targetID)
	if err != nil {
		return nil, err
	}
	return client.Logs(ctx, target.ArgoApplication, s.config.ArgoNamespace, query)
}

// TargetStatus returns the live Argo CD state of one deployment, which the
// console polls while a sync runs.
func (s *Service) TargetStatus(
	ctx context.Context,
	onboardingID, targetID string,
) (ArgoAppStatus, error) {
	target, client, err := s.target(ctx, onboardingID, targetID)
	if err != nil {
		return ArgoAppStatus{}, err
	}
	callCtx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
	defer cancel()
	return client.ApplicationStatus(callCtx, target.ArgoApplication, s.config.ArgoNamespace)
}

func (s *Service) TargetEvents(
	ctx context.Context,
	onboardingID, targetID string,
	query EventQuery,
) ([]ArgoEvent, error) {
	if err := validateEventQuery(query); err != nil {
		return nil, err
	}
	target, client, err := s.target(ctx, onboardingID, targetID)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
	defer cancel()
	return client.ApplicationEvents(callCtx, target.ArgoApplication, s.config.ArgoNamespace, query)
}

// Container is one container of a Pod template, for choosing which log
// stream to follow.
type Container struct {
	Name  string `json:"name"`
	Image string `json:"image"`
	Init  bool   `json:"init"`
}

// Containers reads the containers from the live manifest rather than the
// desired one, so a Pod mutated by an admission webhook (sidecars) lists what
// actually runs.
func (s *Service) Containers(
	ctx context.Context,
	onboardingID, targetID string,
	ref ResourceRef,
) ([]Container, error) {
	target, client, err := s.target(ctx, onboardingID, targetID)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
	defer cancel()
	manifest, err := client.ResourceManifest(callCtx, target.ArgoApplication, s.config.ArgoNamespace, ref)
	if err != nil {
		return nil, err
	}
	return containersFromManifest(manifest), nil
}

type podSpec struct {
	Containers     []Container `yaml:"containers"`
	InitContainers []Container `yaml:"initContainers"`
}

func containersFromManifest(manifest string) []Container {
	var object struct {
		Spec struct {
			podSpec  `yaml:",inline"`
			Template struct {
				Spec podSpec `yaml:"spec"`
			} `yaml:"template"`
			JobTemplate struct {
				Spec struct {
					Template struct {
						Spec podSpec `yaml:"spec"`
					} `yaml:"template"`
				} `yaml:"spec"`
			} `yaml:"jobTemplate"`
		} `yaml:"spec"`
	}
	containers := []Container{}
	if err := yaml.Unmarshal([]byte(manifest), &object); err != nil {
		return containers
	}
	spec := object.Spec.podSpec
	if len(spec.Containers) == 0 {
		spec = object.Spec.Template.Spec
	}
	if len(spec.Containers) == 0 {
		spec = object.Spec.JobTemplate.Spec.Template.Spec
	}
	for _, container := range spec.InitContainers {
		containers = append(containers, Container{Name: container.Name, Image: container.Image, Init: true})
	}
	for _, container := range spec.Containers {
		containers = append(containers, Container{Name: container.Name, Image: container.Image})
	}
	return containers
}

// valuesPath returns the release-scoped values file the application's Argo
// CD sources read, after checking the repository can be written at all.
func (s *Service) valuesPath(record model.ApplicationOnboarding) (string, error) {
	if s.github == nil || record.ValuesRepositoryName == "" || record.ValuesRevision == "" {
		return "", ValidationError{Message: "application values repository is not configured"}
	}
	if record.Environment == "" || record.Region == "" {
		return "", ValidationError{Message: "application has no release-scoped values file"}
	}
	return releaseValuesPath(record.Environment, record.Region), nil
}

// ValuesHistory is the commit history of an application's release values.
type ValuesHistory struct {
	Path   string         `json:"path"`
	Branch string         `json:"branch"`
	Items  []ValuesCommit `json:"items"`
}

func (s *Service) Revisions(ctx context.Context, id string, limit int) (ValuesHistory, error) {
	if limit < 1 || limit > MaxRevisionPage {
		return ValuesHistory{}, ValidationError{
			Message: fmt.Sprintf("limit must be between 1 and %d", MaxRevisionPage),
		}
	}
	record, err := s.store.GetApplicationOnboarding(ctx, id)
	if err != nil {
		return ValuesHistory{}, err
	}
	path, err := s.valuesPath(record)
	if err != nil {
		return ValuesHistory{}, err
	}
	items, err := s.github.ValuesHistory(ctx, record.ValuesRepositoryName, record.ValuesRevision, path, limit)
	if err != nil {
		return ValuesHistory{}, ExternalError{Err: fmt.Errorf("list values history: %w", err)}
	}
	return ValuesHistory{Path: path, Branch: record.ValuesRevision, Items: items}, nil
}

// RevisionValues is a release values file as it was at one commit, with
// secret-looking values hidden.
type RevisionValues struct {
	SHA          string   `json:"sha"`
	Path         string   `json:"path"`
	ValuesYAML   string   `json:"valuesYaml"`
	RedactedKeys []string `json:"redactedKeys"`
}

// errNotInHistory reports a commit that did not change the values file within
// the newest MaxRevisionPage commits that did.
var errNotInHistory = errors.New("commit is not in the values file history")

// historyCommit resolves sha, which may be abbreviated, to a commit that
// changed the release values file. Only such a commit is a meaningful
// revision: any other commit in the repository would restore or reveal
// another release's values.
func (s *Service) historyCommit(
	ctx context.Context,
	record model.ApplicationOnboarding,
	path, sha string,
) (string, error) {
	history, err := s.github.ValuesHistory(
		ctx, record.ValuesRepositoryName, record.ValuesRevision, path, MaxRevisionPage,
	)
	if err != nil {
		return "", ExternalError{Err: fmt.Errorf("list values history: %w", err)}
	}
	if len(history) == 0 {
		return "", ValidationError{Message: "application has no release-scoped values file"}
	}
	for _, commit := range history {
		if strings.HasPrefix(commit.SHA, sha) {
			return commit.SHA, nil
		}
	}
	return "", errNotInHistory
}

// RevisionValues reads the release values file at sha. The API has no
// authentication, so it only serves commits from the file's own history and
// redacts secret-looking values: a values file may hold credentials that were
// never meant to leave the repository.
func (s *Service) RevisionValues(ctx context.Context, id, sha string) (RevisionValues, error) {
	if !ValidCommitSHA(sha) {
		return RevisionValues{}, ValidationError{Message: "sha must be a 7 to 40 character hex commit id"}
	}
	record, err := s.store.GetApplicationOnboarding(ctx, id)
	if err != nil {
		return RevisionValues{}, err
	}
	path, err := s.valuesPath(record)
	if err != nil {
		return RevisionValues{}, err
	}
	fullSHA, err := s.historyCommit(ctx, record, path, sha)
	var validationError ValidationError
	if errors.Is(err, errNotInHistory) || errors.As(err, &validationError) {
		return RevisionValues{}, ErrRevisionNotFound
	}
	if err != nil {
		return RevisionValues{}, err
	}
	values, err := s.github.ValuesAt(ctx, record.ValuesRepositoryName, path, fullSHA)
	if errors.Is(err, ErrRevisionNotFound) {
		return RevisionValues{}, err
	}
	if err != nil {
		return RevisionValues{}, ExternalError{Err: fmt.Errorf("read values at revision: %w", err)}
	}
	redacted, keys := RedactValues(values)
	return RevisionValues{SHA: sha, Path: path, ValuesYAML: redacted, RedactedKeys: keys}, nil
}
