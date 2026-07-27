package secure

import (
	"bytes"
	"testing"
)

func TestCredentialRoundTrip(t *testing.T) {
	key := bytes.Repeat([]byte{7}, KeyBytes)
	ciphertext, nonce, err := Encrypt(key, []byte("cluster-password"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("cluster-password")) {
		t.Fatal("ciphertext exposed plaintext")
	}
	plaintext, err := Decrypt(key, ciphertext, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != "cluster-password" {
		t.Fatalf("unexpected plaintext: %q", plaintext)
	}
}

func TestCredentialRejectsWrongKey(t *testing.T) {
	key := bytes.Repeat([]byte{7}, KeyBytes)
	ciphertext, nonce, err := Encrypt(key, []byte("cluster-password"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decrypt(bytes.Repeat([]byte{8}, KeyBytes), ciphertext, nonce); err == nil {
		t.Fatal("expected authentication failure")
	}
}
