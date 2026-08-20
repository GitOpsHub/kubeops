package store

import "testing"

func TestWithScheme(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"bare hostname", "argo.example.test", "https://argo.example.test"},
		{"bare IP", "35.196.52.136", "https://35.196.52.136"},
		{"already has scheme", "https://argo.example.test", "https://argo.example.test"},
		{"http scheme is preserved", "http://argo.example.test", "http://argo.example.test"},
		{"empty", "", ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := withScheme(test.input); got != test.want {
				t.Fatalf("withScheme(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}
