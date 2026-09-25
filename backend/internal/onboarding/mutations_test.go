package onboarding

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

func twoTargetService(client *fakeArgoClient) (*Service, *fakeRepository) {
	service, repository := consoleService(client, nil)
	second := repository.record.Targets[0]
	second.ID, second.ArgoApplication = "target-2", "payments-dev-us-east-1-b"
	repository.record.Targets = append(repository.record.Targets, second)
	return service, repository
}

func TestSyncWithOptions(t *testing.T) {
	for _, test := range []struct {
		name        string
		options     SyncOptions
		syncErr     error
		wantSynced  []string
		wantError   string
		wantRestart bool
		wantCreate  bool
		wantUpdates int
	}{
		{name: "default syncs every target", options: DefaultSyncOptions(),
			wantSynced:  []string{"payments-dev-us-east-1", "payments-dev-us-east-1-b"},
			wantRestart: true, wantCreate: true, wantUpdates: 2},
		{name: "subset", options: SyncOptions{TargetIDs: []string{"target-2", "target-2"}, Prune: true},
			wantSynced: []string{"payments-dev-us-east-1-b"}, wantRestart: true, wantCreate: true, wantUpdates: 1},
		{name: "unknown target", options: SyncOptions{TargetIDs: []string{"target-9"}},
			wantError: "targetIds must name"},
		// A dry run must leave no trace: no recreated application, no restarted
		// timeout window, no stored status.
		{name: "dry run", options: SyncOptions{DryRun: true, Prune: true, TargetIDs: []string{"target-1"}},
			wantSynced: []string{"payments-dev-us-east-1"}},
		{name: "dry run refused", options: SyncOptions{DryRun: true}, syncErr: errors.New("status 500"),
			wantSynced: []string{"payments-dev-us-east-1", "payments-dev-us-east-1-b"},
			wantError:  ErrDryRunFailed.Error()},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeArgoClient{
				state:   ApplicationState{SyncStatus: "OutOfSync", HealthStatus: "Progressing"},
				syncErr: test.syncErr,
			}
			service, repository := twoTargetService(client)
			_, err := service.SyncWithOptions(context.Background(), "onboarding-1", test.options)
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("expected %q, got %v", test.wantError, err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			synced := strings.Join(client.syncedNames, ",")
			if len(client.syncedNames) != len(test.wantSynced) {
				t.Fatalf("expected %v synced, got %s", test.wantSynced, synced)
			}
			for _, name := range test.wantSynced {
				if !strings.Contains(synced, name) {
					t.Fatalf("expected %v synced, got %s", test.wantSynced, synced)
				}
			}
			if len(test.wantSynced) > 0 && (client.syncOptions.DryRun != test.options.DryRun ||
				client.syncOptions.Prune != test.options.Prune) {
				t.Fatalf("options were not forwarded: %#v", client.syncOptions)
			}
			if (len(repository.restarted) > 0) != test.wantRestart ||
				(client.created.Name != "") != test.wantCreate || len(repository.updates) != test.wantUpdates {
				t.Fatalf("unexpected side effects: restarted=%v created=%q updates=%d",
					repository.restarted, client.created.Name, len(repository.updates))
			}
		})
	}
}

func TestTerminateOperation(t *testing.T) {
	for _, test := range []struct {
		name     string
		target   string
		clientEr error
		want     error
	}{
		{name: "running operation", target: "target-1"},
		{name: "nothing running", target: "target-1", clientEr: ErrNoOperation, want: ErrNoOperation},
		{name: "unknown target", target: "target-9", want: ErrTargetNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeArgoClient{terminateErr: test.clientEr}
			service, _ := consoleService(client, nil)
			err := service.TerminateOperation(context.Background(), "onboarding-1", test.target)
			if !errors.Is(err, test.want) && !(err == nil && test.want == nil) {
				t.Fatalf("expected %v, got %v", test.want, err)
			}
			if test.want == nil && client.terminated != "payments-dev-us-east-1" {
				t.Fatalf("unexpected terminate call: %q", client.terminated)
			}
		})
	}
}

func TestRollback(t *testing.T) {
	const full = "abc1234def5678abc1234def5678abc1234def56"
	history := []ValuesCommit{{SHA: "fff0000"}, {SHA: full}}
	success := func() *fakeValuesRepositoryManager {
		return &fakeValuesRepositoryManager{
			history: history, restore: ValuesUpdate{CommitSHA: "rollback-commit", ValuesYAML: "replicaCount: 2\n"},
		}
	}
	for _, test := range []struct {
		name       string
		sha        string
		values     *fakeValuesRepositoryManager
		mutate     func(*model.ApplicationOnboarding)
		repository func(*fakeRepository)
		wantError  string
		external   bool
		conflict   bool
		// followUp names the step that failed after the values commit landed.
		followUp string
	}{
		{name: "invalid sha", sha: "HEAD", values: &fakeValuesRepositoryManager{}, wantError: "commitSha must be"},
		{name: "offboarded", sha: "abc1234", values: &fakeValuesRepositoryManager{},
			mutate:    func(record *model.ApplicationOnboarding) { record.Status = model.OnboardingOffboarded },
			wantError: "offboarded"},
		{name: "unconfigured", sha: "abc1234", wantError: "not configured"},
		{name: "no release file", sha: "abc1234", values: &fakeValuesRepositoryManager{},
			wantError: "no release-scoped values file"},
		{name: "not in history", sha: "0123456", values: &fakeValuesRepositoryManager{history: history},
			wantError: "not in the recent history"},
		{name: "unchanged", sha: "abc1234",
			values:    &fakeValuesRepositoryManager{history: history, restoreErr: ErrValuesUnchanged},
			wantError: "already match"},
		{name: "history failure", sha: "abc1234",
			values: &fakeValuesRepositoryManager{historyErr: errors.New("status 502")}, external: true},
		{name: "restore failure", sha: "abc1234",
			values:   &fakeValuesRepositoryManager{history: history, restoreErr: errors.New("status 500")},
			external: true},
		{name: "values changed during the rollback", sha: "abc1234",
			values:   &fakeValuesRepositoryManager{history: history, restoreErr: ErrValuesConflict},
			conflict: true},
		{name: "commit recorded but not stored", sha: "abc1234", values: success(),
			repository: func(repository *fakeRepository) { repository.valuesErr = errors.New("connection reset") },
			followUp:   RollbackStepRecord},
		{name: "commit stored but not synced", sha: "abc1234", values: success(),
			repository: func(repository *fakeRepository) { repository.restartErr = errors.New("connection reset") },
			followUp:   RollbackStepSync},
		{name: "success", sha: "abc1234", values: success()},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeArgoClient{state: ApplicationState{SyncStatus: "OutOfSync", HealthStatus: "Progressing"}}
			service, repository := consoleService(client, test.values)
			if test.mutate != nil {
				test.mutate(&repository.record)
			}
			if test.repository != nil {
				test.repository(repository)
			}
			record, err := service.Rollback(context.Background(), "onboarding-1", test.sha)
			var validationError ValidationError
			var externalError ExternalError
			var followUpError RollbackFollowUpError
			switch {
			case test.followUp != "":
				if !errors.As(err, &followUpError) || followUpError.Step != test.followUp ||
					followUpError.CommitSHA != "rollback-commit" {
					t.Fatalf("expected a %s follow-up error, got %v", test.followUp, err)
				}
				if !strings.HasPrefix(followUpError.Message(), "Rolled back values in commit rollbac, but ") ||
					strings.Contains(followUpError.Message(), "connection reset") {
					t.Fatalf("unexpected message: %q", followUpError.Message())
				}
				if test.followUp == RollbackStepSync && repository.valuesCommitSHA != "rollback-commit" {
					t.Fatalf("a failed sync must still leave the commit recorded, got %q", repository.valuesCommitSHA)
				}
				return
			case test.conflict:
				if !errors.Is(err, ErrValuesConflict) || errors.As(err, &externalError) {
					t.Fatalf("expected ErrValuesConflict, got %v", err)
				}
			case test.wantError != "":
				if !errors.As(err, &validationError) || !strings.Contains(validationError.Message, test.wantError) {
					t.Fatalf("expected %q, got %v", test.wantError, err)
				}
			case test.external:
				if !errors.As(err, &externalError) {
					t.Fatalf("expected an external error, got %v", err)
				}
			case err != nil:
				t.Fatal(err)
			}
			if test.wantError != "" || test.external || test.conflict {
				if client.synced != "" || repository.valuesCommitSHA != "" {
					t.Fatal("a failed rollback must not record values or sync")
				}
				return
			}
			// The abbreviated sha resolves to the file's commit before restoring.
			if test.values.restoredSHA != full || test.values.restoredPath != "dev/us-east-1/values.yaml" ||
				repository.valuesCommitSHA != "rollback-commit" || client.synced != "payments-dev-us-east-1" ||
				record.ValuesCommitSHA != "rollback-commit" {
				t.Fatalf("rollback did not restore and sync: manager=%#v repository=%q synced=%q",
					test.values, repository.valuesCommitSHA, client.synced)
			}
		})
	}
}
