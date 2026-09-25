package onboarding

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

// ErrDryRunFailed reports that Argo CD refused a dry run on at least one of
// the selected targets.
var ErrDryRunFailed = errors.New("Argo CD could not start the dry run")

// Rollback steps that can fail after the values commit already landed.
const (
	RollbackStepRecord = "record"
	RollbackStepSync   = "sync"
)

// RollbackFollowUpError reports a rollback whose values commit landed on the
// branch but whose later step failed. The commit cannot be taken back, so the
// caller must say it exists rather than that the rollback failed: retrying
// would only find the values already match.
type RollbackFollowUpError struct {
	// CommitSHA is the rollback commit now on the values branch.
	CommitSHA string
	Step      string
	Err       error
}

func (e RollbackFollowUpError) Error() string {
	return fmt.Sprintf("rolled back values in commit %s, then %s failed: %v", shortSHA(e.CommitSHA), e.Step, e.Err)
}

func (e RollbackFollowUpError) Unwrap() error { return e.Err }

// Message explains the outcome without the underlying error, which may carry
// internal detail.
func (e RollbackFollowUpError) Message() string {
	outcome := "KubeOps could not record it"
	if e.Step == RollbackStepSync {
		outcome = "KubeOps could not start the sync"
	}
	// The generated Applications sync automatically, so the commit deploys
	// on Argo CD's next poll whatever failed here.
	return fmt.Sprintf("Rolled back values in commit %s, but %s. Argo CD's automated sync will still apply it.",
		shortSHA(e.CommitSHA), outcome)
}

// selectTargets narrows targets to ids, preserving their stored order. No ids
// means every target; an id the onboarding does not own is a validation error
// rather than silently ignored, so a stale UI cannot believe it synced a
// cluster it did not.
func selectTargets(targets []model.ApplicationDeployment, ids []string) ([]model.ApplicationDeployment, error) {
	ids = uniqueStrings(ids)
	if len(ids) == 0 {
		return targets, nil
	}
	wanted := make(map[string]bool, len(ids))
	for _, id := range ids {
		wanted[id] = true
	}
	selected := make([]model.ApplicationDeployment, 0, len(ids))
	for _, target := range targets {
		if wanted[target.ID] {
			selected = append(selected, target)
			delete(wanted, target.ID)
		}
	}
	if len(wanted) > 0 {
		return nil, ValidationError{Message: "targetIds must name deployment targets of this application"}
	}
	return selected, nil
}

func (s *Service) dryRun(ctx context.Context, record model.ApplicationOnboarding, options SyncOptions) error {
	var wait sync.WaitGroup
	var mu sync.Mutex
	failed := 0
	fail := func() {
		mu.Lock()
		failed++
		mu.Unlock()
	}
	for _, target := range record.Targets {
		wait.Add(1)
		go func() {
			defer wait.Done()
			defer func() {
				if recovered := recover(); recovered != nil {
					slog.Error("panic in dry run", "onboarding", record.ID, "target", target.ID, "panic", recovered)
					fail()
				}
			}()
			client, err := s.resolveClient(ctx, target.SourceID, target.ProviderResourceID, target.ClusterName)
			if err != nil {
				slog.Error("resolve Argo CD client for dry run",
					"onboarding", record.ID, "target", target.ID, "error", err)
				fail()
				return
			}
			callCtx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
			defer cancel()
			if _, err := client.SyncApplication(
				callCtx, target.ArgoApplication, s.config.ArgoNamespace, options,
			); err != nil {
				slog.Error("dry-run sync Argo CD application",
					"onboarding", record.ID, "target", target.ID,
					"application", target.ArgoApplication, "error", err)
				fail()
			}
		}()
	}
	wait.Wait()
	if failed > 0 {
		return fmt.Errorf("%w on %d of %d targets", ErrDryRunFailed, failed, len(record.Targets))
	}
	return nil
}

// TerminateOperation stops the sync running on one target.
func (s *Service) TerminateOperation(ctx context.Context, onboardingID, targetID string) error {
	target, client, err := s.target(ctx, onboardingID, targetID)
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
	defer cancel()
	if err := client.TerminateOperation(callCtx, target.ArgoApplication, s.config.ArgoNamespace); err != nil {
		return err
	}
	slog.Info("terminated Argo CD operation", "onboarding", onboardingID, "target", targetID)
	return nil
}

// Rollback restores the release values file to its content at sha with a new
// commit, then syncs, exactly like Scale. Argo CD's own rollback is not usable:
// the generated applications sync automatically with self-heal, which Argo CD
// refuses to roll back and would revert anyway. The chart revision and the
// shared root values.yaml are deliberately left alone.
func (s *Service) Rollback(ctx context.Context, id, sha string) (model.ApplicationOnboarding, error) {
	if !ValidCommitSHA(sha) {
		return model.ApplicationOnboarding{}, ValidationError{Message: "commitSha must be a 7 to 40 character hex commit id"}
	}
	record, err := s.store.GetApplicationOnboarding(ctx, id)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	if record.Status == model.OnboardingOffboarded {
		return model.ApplicationOnboarding{}, ValidationError{Message: "offboarded applications cannot be rolled back"}
	}
	path, err := s.valuesPath(record)
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	fullSHA, err := s.historyCommit(ctx, record, path, sha)
	if errors.Is(err, errNotInHistory) {
		return model.ApplicationOnboarding{}, ValidationError{
			Message: fmt.Sprintf("commit %s is not in the recent history of %s", shortSHA(sha), path),
		}
	}
	if err != nil {
		return model.ApplicationOnboarding{}, err
	}
	update, err := s.github.RestoreValues(ctx, record.ValuesRepositoryName, record.ValuesRevision, path, fullSHA)
	switch {
	case errors.Is(err, ErrValuesUnchanged):
		return model.ApplicationOnboarding{}, ValidationError{
			Message: fmt.Sprintf("values at %s already match the current values", shortSHA(fullSHA)),
		}
	case errors.Is(err, ErrValuesConflict):
		return model.ApplicationOnboarding{}, err
	case errors.Is(err, ErrRevisionNotFound):
		return model.ApplicationOnboarding{}, ValidationError{
			Message: fmt.Sprintf("%s did not exist at %s", path, shortSHA(fullSHA)),
		}
	case err != nil:
		return model.ApplicationOnboarding{}, ExternalError{Err: fmt.Errorf("roll back values: %w", err)}
	}
	slog.Info("rolled back application values",
		"onboarding", record.ID, "sha", fullSHA, "commit", update.CommitSHA)
	digest := sha256.Sum256([]byte(update.ValuesYAML))
	// The commit has landed, so record it even if the caller has hung up.
	if err := s.store.UpdateApplicationOnboardingValues(
		context.WithoutCancel(ctx), record.ID, "sha256:"+hex.EncodeToString(digest[:]), update.CommitSHA,
	); err != nil {
		return model.ApplicationOnboarding{}, RollbackFollowUpError{
			CommitSHA: update.CommitSHA, Step: RollbackStepRecord,
			Err: fmt.Errorf("store rolled back application values: %w", err),
		}
	}
	synced, err := s.Sync(ctx, id)
	if err != nil {
		return model.ApplicationOnboarding{}, RollbackFollowUpError{
			CommitSHA: update.CommitSHA, Step: RollbackStepSync, Err: err,
		}
	}
	return synced, nil
}
