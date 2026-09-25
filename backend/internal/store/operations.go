package store

import (
	"context"
	"encoding/json"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

// RecordApplicationOperation appends to an application's audit trail. A
// malformed onboarding or target id is dropped rather than failing the query:
// the caller has already acted, and the trail is best effort.
func (s *Store) RecordApplicationOperation(ctx context.Context, operation model.ApplicationOperation) error {
	if !validUUID(operation.OnboardingID) {
		return nil
	}
	var targetID *string
	if operation.TargetID != nil && validUUID(*operation.TargetID) {
		targetID = operation.TargetID
	}
	params := operation.Params
	if params == nil {
		params = map[string]any{}
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO application_operations (onboarding_id, target_id, kind, params, result)
		VALUES ($1, $2, $3, $4, $5)`,
		operation.OnboardingID, targetID, operation.Kind, encoded, operation.Result,
	)
	return err
}

// ListApplicationOperations returns an application's audit trail, newest first.
func (s *Store) ListApplicationOperations(
	ctx context.Context,
	onboardingID string,
	limit int,
) ([]model.ApplicationOperation, error) {
	operations := make([]model.ApplicationOperation, 0)
	if !validUUID(onboardingID) {
		return operations, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, onboarding_id::text, target_id::text, kind, params, result, created_at
		FROM application_operations
		WHERE onboarding_id = $1
		ORDER BY created_at DESC, id
		LIMIT $2`, onboardingID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var operation model.ApplicationOperation
		var params []byte
		if err := rows.Scan(
			&operation.ID, &operation.OnboardingID, &operation.TargetID, &operation.Kind,
			&params, &operation.Result, &operation.CreatedAt,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(params, &operation.Params); err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	return operations, rows.Err()
}
