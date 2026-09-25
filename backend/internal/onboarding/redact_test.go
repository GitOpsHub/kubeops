package onboarding

import (
	"reflect"
	"strings"
	"testing"
)

func TestRedactValues(t *testing.T) {
	for _, test := range []struct {
		name     string
		values   string
		want     string
		wantKeys []string
	}{
		{name: "nothing to hide", values: "replicaCount: 3\nimage:\n  tag: v1\n",
			want: "replicaCount: 3\nimage:\n  tag: v1\n", wantKeys: []string{}},
		{name: "empty file", values: "", want: "", wantKeys: []string{}},
		{name: "secret-looking keys in any case",
			values: "db:\n  Password: hunter2\n  host: db\napiKey: k\nAPI_KEY: k\nclient_secret: s\n" +
				"githubToken: t\nsentryDsn: https://x.ingest\ncredentials: c\nconnectionString: c\n",
			want: "db:\n  Password: <redacted>\n  host: db\napiKey: <redacted>\nAPI_KEY: <redacted>\n" +
				"client_secret: <redacted>\ngithubToken: <redacted>\nsentryDsn: <redacted>\n" +
				"credentials: <redacted>\nconnectionString: <redacted>\n",
			wantKeys: []string{"db.Password", "apiKey", "API_KEY", "client_secret", "githubToken", "sentryDsn",
				"credentials", "connectionString"}},
		{name: "everything below a secret-looking key",
			values:   "auth:\n  enabled: true\n  username: admin\n  keys:\n    - k1\n    - k2\n  expiry: 30\n  empty: \"\"\n",
			want:     "auth:\n  enabled: true\n  username: <redacted>\n  keys:\n    - <redacted>\n    - <redacted>\n  expiry: <redacted>\n  empty: \"\"\n",
			wantKeys: []string{"auth.username", "auth.keys[0]", "auth.keys[1]", "auth.expiry"}},
		{name: "flags and empty values under a secret key stay",
			values: "tls:\n  certManager: true\n  secretName:\n",
			want:   "tls:\n  certManager: true\n  secretName:\n", wantKeys: []string{}},
		{name: "env entry named like a secret",
			values:   "env:\n  - name: LOG_LEVEL\n    value: debug\n  - name: DB_PASSWORD\n    value: hunter2\n",
			want:     "env:\n  - name: LOG_LEVEL\n    value: debug\n  - name: DB_PASSWORD\n    value: <redacted>\n",
			wantKeys: []string{"env[1].value"}},
		{name: "URL with userinfo under any key",
			values:   "database:\n  url: postgres://app:hunter2@db:5432/app\n  replica: https://db.internal/app\n",
			want:     "database:\n  url: <redacted>\n  replica: https://db.internal/app\n",
			wantKeys: []string{"database.url"}},
		{name: "URL with userinfo inside a longer value",
			values: "args:\n  - --verbose\n  - --db=mysql://root:pw@db/app\n",
			want:   "args:\n  - --verbose\n  - <redacted>\n", wantKeys: []string{"args[1]"}},
		{name: "embedded config file with a secret assignment",
			values: "config: |\n  [db]\n  host = db\n  password = hunter2\nbanner: |\n  hello\n  world\n",
			want:   "config: <redacted>\nbanner: |\n  hello\n  world\n", wantKeys: []string{"config"}},
		{name: "block scalar under a secret key",
			values: "privateKey: |\n  -----BEGIN KEY-----\n  abc\n",
			want:   "privateKey: <redacted>\n", wantKeys: []string{"privateKey"}},
		{name: "anchored secret reached through an alias",
			values:   "shared: &pw hunter2\ndb:\n  password: *pw\n",
			want:     "shared: &pw <redacted>\ndb:\n  password: *pw\n",
			wantKeys: []string{"db.password"}},
		{name: "comments survive",
			values:   "# release values\ntoken: abc # rotated monthly\n",
			want:     "# release values\ntoken: <redacted> # rotated monthly\n",
			wantKeys: []string{"token"}},
		{name: "every document of a stream",
			values:   "a: 1\n---\ntoken: abc\n",
			want:     "a: 1\n---\ntoken: <redacted>\n",
			wantKeys: []string{"token"}},
		{name: "invalid YAML is withheld", values: "password: [unterminated\n", want: "", wantKeys: []string{"*"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, keys := RedactValues(test.values)
			if got != test.want || !reflect.DeepEqual(keys, test.wantKeys) {
				t.Fatalf("got %q %q\nwant %q %q", got, keys, test.want, test.wantKeys)
			}
			if strings.Contains(got, "hunter2") {
				t.Fatalf("secret survived redaction: %q", got)
			}
		})
	}
}
