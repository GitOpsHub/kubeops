package provider

import "testing"

func TestEndpointAccess(t *testing.T) {
	tests := []struct {
		public  bool
		private bool
		want    string
	}{
		{true, true, "both"},
		{true, false, "public"},
		{false, true, "private"},
		{false, false, "unknown"},
	}
	for _, test := range tests {
		if got := EndpointAccess(test.public, test.private); got != test.want {
			t.Fatalf("EndpointAccess(%t, %t) = %q, want %q", test.public, test.private, got, test.want)
		}
	}
}
