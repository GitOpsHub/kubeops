package store

import (
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/jackc/pgx/v5"
)

func TestPoolConfig(t *testing.T) {
	tests := []struct {
		name         string
		url          string
		options      Options
		wantMaxConns int32
		wantMode     pgx.QueryExecMode
	}{
		{
			name:         "direct connection keeps prepared statements",
			url:          "postgres://u:p@127.0.0.1:5432/kubeops",
			wantMaxConns: defaultMaxConns, wantMode: pgx.QueryExecModeCacheStatement,
		},
		{
			name:         "Neon pooler host is detected",
			url:          "postgres://u:p@ep-cool-name-123-pooler.us-east-2.aws.neon.tech/kubeops",
			wantMaxConns: defaultMaxConns, wantMode: pgx.QueryExecModeCacheDescribe,
		},
		{
			name:         "explicit transaction pooler and pool size",
			url:          "postgres://u:p@pgbouncer.internal:6432/kubeops",
			options:      Options{Pooler: "transaction", MaxConns: 10},
			wantMaxConns: 10, wantMode: pgx.QueryExecModeCacheDescribe,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config, err := poolConfig(test.url, test.options)
			if err != nil {
				t.Fatal(err)
			}
			if config.MaxConns != test.wantMaxConns {
				t.Fatalf("MaxConns = %d, want %d", config.MaxConns, test.wantMaxConns)
			}
			if config.ConnConfig.DefaultQueryExecMode != test.wantMode {
				t.Fatalf("exec mode = %v, want %v", config.ConnConfig.DefaultQueryExecMode, test.wantMode)
			}
			if config.MaxConnIdleTime != 30*time.Second || config.MaxConnLifetime != 5*time.Minute {
				t.Fatalf("unexpected connection lifetimes: idle %s, lifetime %s",
					config.MaxConnIdleTime, config.MaxConnLifetime)
			}
		})
	}
}

func TestValidUUID(t *testing.T) {
	tests := []struct {
		id   string
		want bool
	}{
		{id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", want: true},
		{id: "not-a-uuid"},
		{id: ""},
		// uuid.Parse accepts these, PostgreSQL's uuid input does not.
		{id: "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301"},
		{id: "{3f2504e0-4f89-11d3-9a0c-0305e82c3301}"},
	}
	for _, test := range tests {
		if got := validUUID(test.id); got != test.want {
			t.Errorf("validUUID(%q) = %t, want %t", test.id, got, test.want)
		}
	}
}

func TestClusterOrder(t *testing.T) {
	for _, test := range []struct {
		filter model.ClusterFilter
		want   string
	}{
		{filter: model.ClusterFilter{}, want: "c.name, c.provider, c.location, c.id"},
		{filter: model.ClusterFilter{Sort: "bogus"}, want: "c.name, c.provider, c.location, c.id"},
		{filter: model.ClusterFilter{Sort: model.ClusterSortNodes, Descending: true},
			want: "c.node_count DESC NULLS LAST, c.id"},
		{filter: model.ClusterFilter{Sort: model.ClusterSortLastSeen},
			want: "c.last_seen_at ASC NULLS LAST, c.id"},
	} {
		if got := clusterOrder(test.filter); got != test.want {
			t.Errorf("clusterOrder(%#v) = %q, want %q", test.filter, got, test.want)
		}
	}
}
