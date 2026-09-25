package onboarding

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"time"
)

// ErrNoOperation reports that a terminate request found no sync operation in
// flight on the application.
var ErrNoOperation = errors.New("no Argo CD operation is in progress")

// ArgoAppStatus is the console's view of one Argo CD application. It is built
// by its own decoder rather than from ApplicationState so the reconciler's
// contract stays small, and it deliberately has no field for spec.source(s),
// repoURL, or anything else that names where the chart or values live: the API
// is unauthenticated.
type ArgoAppStatus struct {
	Sync         ArgoSyncStatus     `json:"sync"`
	Health       ArgoHealth         `json:"health"`
	Operation    *ArgoOperation     `json:"operation"`
	History      []ArgoHistoryEntry `json:"history"`
	Conditions   []ArgoCondition    `json:"conditions"`
	Images       []string           `json:"images"`
	ReconciledAt *time.Time         `json:"reconciledAt"`
}

type ArgoSyncStatus struct {
	Status    string   `json:"status"`
	Revisions []string `json:"revisions"`
}

type ArgoHealth struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

type ArgoInitiator struct {
	Username  string `json:"username,omitempty"`
	Automated bool   `json:"automated"`
}

// ArgoOperation is the last (or current) operation Argo CD ran. Phase is
// Running, Terminating, Succeeded, Failed, or Error.
type ArgoOperation struct {
	Phase       string                `json:"phase"`
	Message     string                `json:"message,omitempty"`
	StartedAt   *time.Time            `json:"startedAt"`
	FinishedAt  *time.Time            `json:"finishedAt"`
	RetryCount  int64                 `json:"retryCount"`
	InitiatedBy ArgoInitiator         `json:"initiatedBy"`
	DryRun      bool                  `json:"dryRun"`
	Prune       bool                  `json:"prune"`
	Revisions   []string              `json:"revisions"`
	Resources   []ArgoResourceOutcome `json:"resources"`
}

// ArgoResourceOutcome is one resource's result within a sync, including the
// hook lifecycle for PreSync/Sync/PostSync hooks.
type ArgoResourceOutcome struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	Message   string `json:"message,omitempty"`
	HookType  string `json:"hookType,omitempty"`
	HookPhase string `json:"hookPhase,omitempty"`
	SyncPhase string `json:"syncPhase,omitempty"`
}

type ArgoHistoryEntry struct {
	ID              int64         `json:"id"`
	Revisions       []string      `json:"revisions"`
	DeployStartedAt *time.Time    `json:"deployStartedAt"`
	DeployedAt      *time.Time    `json:"deployedAt"`
	InitiatedBy     ArgoInitiator `json:"initiatedBy"`
}

type ArgoCondition struct {
	Type               string     `json:"type"`
	Message            string     `json:"message"`
	LastTransitionTime *time.Time `json:"lastTransitionTime"`
}

// ArgoEvent is a Kubernetes event about the application or one of its
// resources, normalised across the legacy and events.k8s.io field sets.
type ArgoEvent struct {
	Type      string          `json:"type"`
	Reason    string          `json:"reason"`
	Message   string          `json:"message"`
	Count     int32           `json:"count"`
	FirstSeen *time.Time      `json:"firstSeen"`
	LastSeen  *time.Time      `json:"lastSeen"`
	Source    string          `json:"source,omitempty"`
	Object    ArgoEventObject `json:"object"`
}

type ArgoEventObject struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	UID       string `json:"uid,omitempty"`
}

// EventQuery narrows events to one resource. With Name and UID both empty
// Argo CD returns the events of the Application object itself.
type EventQuery struct {
	Kind      string
	Name      string
	Namespace string
	UID       string
}

// LogQuery selects a log stream. Resource.Kind decides the endpoint: a Pod is
// read directly, a workload through Argo CD's application-level log endpoint,
// which merges every Pod the workload owns.
type LogQuery struct {
	Resource     ResourceRef
	Container    string
	TailLines    int64
	SinceSeconds int64
	SinceTime    *time.Time
	Previous     bool
	Filter       string
	Follow       bool
}

// SyncOptions shapes one manual sync. The zero value is not the default:
// callers that have no preference use DefaultSyncOptions, which prunes as
// every sync did before options existed.
type SyncOptions struct {
	// TargetIDs limits the sync to these deployments; empty means all.
	TargetIDs          []string
	Prune              bool
	DryRun             bool
	Force              bool
	ApplyOutOfSyncOnly bool
}

func DefaultSyncOptions() SyncOptions {
	return SyncOptions{Prune: true}
}

// Argo CD condition, operation, event, and log-stream error messages quote
// repository and registry URLs verbatim, and credentials embedded in one would
// otherwise reach an unauthenticated caller.
var (
	// credentialsInURL matches a URL's userinfo. It runs to the last @ before
	// the host, because a password may itself contain @; the scheme is any, so
	// oci:// and git+ssh:// URLs are covered too.
	credentialsInURL = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^/\s]*@`)
	// credentialsInQuery matches the value of a query parameter that carries a
	// credential, such as access_token, a signed URL's X-Amz-Signature, or
	// sig.
	credentialsInQuery = regexp.MustCompile(
		`(?i)([?&][\w.-]*(?:token|key|secret|passw(?:or)?d|sig|signature|credential)[\w.-]*=)[^&\s#"']*`)
)

// ScrubMessage removes credentials from URLs quoted in an Argo CD message.
func ScrubMessage(message string) string {
	message = credentialsInURL.ReplaceAllString(message, "$1")
	return credentialsInQuery.ReplaceAllString(message, "${1}"+RedactedValue)
}

type argoInitiatorPayload struct {
	Username  string `json:"username"`
	Automated bool   `json:"automated"`
}

// ApplicationStatus reads the application and keeps only the operational
// fields the console needs.
func (c *HTTPArgoClient) ApplicationStatus(
	ctx context.Context,
	name, argoNamespace string,
) (ArgoAppStatus, error) {
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"?appNamespace=" + url.QueryEscape(argoNamespace)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ArgoAppStatus{}, err
	}
	request.Header.Set("Authorization", c.authorization())

	var application struct {
		Status struct {
			Sync struct {
				Status    string   `json:"status"`
				Revision  string   `json:"revision"`
				Revisions []string `json:"revisions"`
			} `json:"sync"`
			Health struct {
				Status  string `json:"status"`
				Message string `json:"message"`
			} `json:"health"`
			OperationState *struct {
				Phase      string     `json:"phase"`
				Message    string     `json:"message"`
				StartedAt  *time.Time `json:"startedAt"`
				FinishedAt *time.Time `json:"finishedAt"`
				RetryCount int64      `json:"retryCount"`
				Operation  struct {
					InitiatedBy argoInitiatorPayload `json:"initiatedBy"`
					Sync        *struct {
						DryRun    bool     `json:"dryRun"`
						Prune     bool     `json:"prune"`
						Revision  string   `json:"revision"`
						Revisions []string `json:"revisions"`
					} `json:"sync"`
				} `json:"operation"`
				SyncResult *struct {
					Revision  string                `json:"revision"`
					Revisions []string              `json:"revisions"`
					Resources []ArgoResourceOutcome `json:"resources"`
				} `json:"syncResult"`
			} `json:"operationState"`
			History []struct {
				ID              int64                `json:"id"`
				Revision        string               `json:"revision"`
				Revisions       []string             `json:"revisions"`
				DeployStartedAt *time.Time           `json:"deployStartedAt"`
				DeployedAt      *time.Time           `json:"deployedAt"`
				InitiatedBy     argoInitiatorPayload `json:"initiatedBy"`
			} `json:"history"`
			Conditions []ArgoCondition `json:"conditions"`
			Summary    struct {
				Images []string `json:"images"`
			} `json:"summary"`
			ReconciledAt *time.Time `json:"reconciledAt"`
		} `json:"status"`
	}
	if err := c.decode(request, &application); err != nil {
		return ArgoAppStatus{}, err
	}

	status := application.Status
	result := ArgoAppStatus{
		Sync: ArgoSyncStatus{
			Status:    valueOrUnknown(status.Sync.Status),
			Revisions: revisionList(status.Sync.Revisions, status.Sync.Revision),
		},
		Health: ArgoHealth{
			Status:  valueOrUnknown(status.Health.Status),
			Message: ScrubMessage(status.Health.Message),
		},
		History:      make([]ArgoHistoryEntry, 0, len(status.History)),
		Conditions:   make([]ArgoCondition, 0, len(status.Conditions)),
		Images:       nonNil(status.Summary.Images),
		ReconciledAt: status.ReconciledAt,
	}
	if state := status.OperationState; state != nil && state.Phase != "" {
		operation := &ArgoOperation{
			Phase: state.Phase, Message: ScrubMessage(state.Message),
			StartedAt: state.StartedAt, FinishedAt: state.FinishedAt,
			RetryCount: state.RetryCount,
			InitiatedBy: ArgoInitiator{
				Username:  state.Operation.InitiatedBy.Username,
				Automated: state.Operation.InitiatedBy.Automated,
			},
			Revisions: []string{},
			Resources: []ArgoResourceOutcome{},
		}
		if sync := state.Operation.Sync; sync != nil {
			operation.DryRun, operation.Prune = sync.DryRun, sync.Prune
			operation.Revisions = revisionList(sync.Revisions, sync.Revision)
		}
		if result := state.SyncResult; result != nil {
			if revisions := revisionList(result.Revisions, result.Revision); len(revisions) > 0 {
				operation.Revisions = revisions
			}
			for _, resource := range result.Resources {
				resource.Message = ScrubMessage(resource.Message)
				operation.Resources = append(operation.Resources, resource)
			}
		}
		result.Operation = operation
	}
	// Argo CD appends history, so the newest deployment is last.
	for index := len(status.History) - 1; index >= 0; index-- {
		entry := status.History[index]
		result.History = append(result.History, ArgoHistoryEntry{
			ID:              entry.ID,
			Revisions:       revisionList(entry.Revisions, entry.Revision),
			DeployStartedAt: entry.DeployStartedAt,
			DeployedAt:      entry.DeployedAt,
			InitiatedBy: ArgoInitiator{
				Username: entry.InitiatedBy.Username, Automated: entry.InitiatedBy.Automated,
			},
		})
	}
	for _, condition := range status.Conditions {
		condition.Message = ScrubMessage(condition.Message)
		result.Conditions = append(result.Conditions, condition)
	}
	return result, nil
}

// revisionList prefers the multi-source revisions Argo CD reports for
// applications with spec.sources, falling back to the single revision.
func revisionList(revisions []string, revision string) []string {
	if len(revisions) > 0 {
		return revisions
	}
	if revision != "" {
		return []string{revision}
	}
	return []string{}
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// maxEvents bounds the events returned for one query; a crash-looping Pod can
// accumulate far more than a person will read.
const maxEvents = 200

// ApplicationEvents lists Kubernetes events for the application or, when the
// query names a resource, for that resource in the destination cluster.
func (c *HTTPArgoClient) ApplicationEvents(
	ctx context.Context,
	name, argoNamespace string,
	query EventQuery,
) ([]ArgoEvent, error) {
	values := url.Values{"appNamespace": []string{argoNamespace}}
	if query.Namespace != "" {
		values.Set("resourceNamespace", query.Namespace)
	}
	if query.Name != "" {
		values.Set("resourceName", query.Name)
	}
	if query.UID != "" {
		values.Set("resourceUID", query.UID)
	}
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"/events?" + values.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", c.authorization())

	var list struct {
		Items []struct {
			Metadata struct {
				CreationTimestamp *time.Time `json:"creationTimestamp"`
			} `json:"metadata"`
			InvolvedObject struct {
				Kind      string `json:"kind"`
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
				UID       string `json:"uid"`
			} `json:"involvedObject"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
			Type    string `json:"type"`
			Count   int32  `json:"count"`
			Source  struct {
				Component string `json:"component"`
			} `json:"source"`
			ReportingComponent string     `json:"reportingComponent"`
			FirstTimestamp     *time.Time `json:"firstTimestamp"`
			LastTimestamp      *time.Time `json:"lastTimestamp"`
			// eventTime is a MicroTime with fractional seconds, which time.Time
			// decodes as RFC 3339 as well.
			EventTime *time.Time `json:"eventTime"`
			Series    *struct {
				Count            int32      `json:"count"`
				LastObservedTime *time.Time `json:"lastObservedTime"`
			} `json:"series"`
		} `json:"items"`
	}
	if err := c.decode(request, &list); err != nil {
		return nil, err
	}

	events := make([]ArgoEvent, 0, len(list.Items))
	for _, item := range list.Items {
		if query.Kind != "" && item.InvolvedObject.Kind != query.Kind {
			continue
		}
		first := firstTime(item.FirstTimestamp, item.EventTime, item.Metadata.CreationTimestamp)
		var seriesLast *time.Time
		count := item.Count
		if item.Series != nil {
			seriesLast = item.Series.LastObservedTime
			if count == 0 {
				count = item.Series.Count
			}
		}
		if count == 0 {
			count = 1
		}
		source := item.Source.Component
		if source == "" {
			source = item.ReportingComponent
		}
		events = append(events, ArgoEvent{
			Type: item.Type, Reason: item.Reason, Message: ScrubMessage(item.Message),
			Count: count, FirstSeen: first,
			LastSeen: firstTime(item.LastTimestamp, seriesLast, item.EventTime, first),
			Source:   source,
			Object: ArgoEventObject{
				Kind: item.InvolvedObject.Kind, Name: item.InvolvedObject.Name,
				Namespace: item.InvolvedObject.Namespace, UID: item.InvolvedObject.UID,
			},
		})
	}
	sort.SliceStable(events, func(i, j int) bool {
		return timeValue(events[i].LastSeen).After(timeValue(events[j].LastSeen))
	})
	if len(events) > maxEvents {
		events = events[:maxEvents]
	}
	return events, nil
}

func firstTime(values ...*time.Time) *time.Time {
	for _, value := range values {
		if value != nil && !value.IsZero() {
			return value
		}
	}
	return nil
}

func timeValue(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}
	return *value
}

// workloadGroups maps each workload kind whose logs can be streamed to its API
// group. The group is taken from here rather than the caller so a request
// cannot name a same-kind resource from an unrelated API.
var workloadGroups = map[string]string{
	"Deployment":  "apps",
	"StatefulSet": "apps",
	"DaemonSet":   "apps",
	"ReplicaSet":  "apps",
	"Job":         "batch",
}

// Logs opens Argo CD's server-streaming log endpoint. A client copy without an
// overall timeout is intentional: the request context owns the lifetime of a
// live stream, while the shared client timeout still protects ordinary calls.
func (c *HTTPArgoClient) Logs(
	ctx context.Context,
	name, argoNamespace string,
	query LogQuery,
) (io.ReadCloser, error) {
	values := url.Values{
		"appNamespace": []string{argoNamespace},
		"namespace":    []string{query.Resource.Namespace},
		"follow":       []string{strconv.FormatBool(query.Follow)},
	}
	if query.TailLines > 0 {
		values.Set("tailLines", strconv.FormatInt(query.TailLines, 10))
	}
	if query.Container != "" {
		values.Set("container", query.Container)
	}
	if query.SinceSeconds > 0 {
		values.Set("sinceSeconds", strconv.FormatInt(query.SinceSeconds, 10))
	}
	if query.SinceTime != nil {
		// grpc-gateway flattens the Kubernetes Time message into its fields.
		values.Set("sinceTime.seconds", strconv.FormatInt(query.SinceTime.Unix(), 10))
		values.Set("sinceTime.nanos", strconv.Itoa(query.SinceTime.Nanosecond()))
	}
	if query.Previous {
		values.Set("previous", "true")
	}
	if query.Filter != "" {
		values.Set("filter", query.Filter)
	}

	base := c.serverURL + "/api/v1/applications/" + url.PathEscape(name)
	var endpoint string
	if group, ok := workloadGroups[query.Resource.Kind]; ok {
		values.Set("kind", query.Resource.Kind)
		values.Set("group", group)
		values.Set("resourceName", query.Resource.Name)
		endpoint = base + "/logs?" + values.Encode()
	} else {
		endpoint = base + "/pods/" + url.PathEscape(query.Resource.Name) + "/logs?" + values.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", c.authorization())
	request.Header.Set("Accept", "application/json")

	streamClient := *c.client
	streamClient.Timeout = 0
	response, err := streamClient.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return response.Body, nil
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	switch response.StatusCode {
	case http.StatusNotFound:
		return nil, ErrResourceNotFound
	case http.StatusForbidden:
		return nil, ErrPodLogsForbidden
	}
	return nil, argoAPIError{status: response.StatusCode}
}

// TerminateOperation stops the sync operation in flight. Argo CD reports
// "nothing to terminate" as a failed precondition, which grpc-gateway renders
// as 400; 409 and 412 are accepted too since proxies and versions differ.
func (c *HTTPArgoClient) TerminateOperation(
	ctx context.Context,
	name, argoNamespace string,
) error {
	endpoint := c.serverURL + "/api/v1/applications/" + url.PathEscape(name) +
		"/operation?appNamespace=" + url.QueryEscape(argoNamespace)
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", c.authorization())
	// The same grpc-gateway media-type requirement that DeleteApplication hits.
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		return nil
	case response.StatusCode == http.StatusBadRequest,
		response.StatusCode == http.StatusConflict,
		response.StatusCode == http.StatusPreconditionFailed:
		return ErrNoOperation
	case response.StatusCode == http.StatusNotFound,
		response.StatusCode == http.StatusForbidden:
		return ErrApplicationNotFound
	}
	return argoAPIError{status: response.StatusCode}
}
