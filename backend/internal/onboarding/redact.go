package onboarding

import (
	"bytes"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// RedactedValue replaces every secret-looking value in values served to the
// browser.
const RedactedValue = "<redacted>"

// secretKeyWords are the fragments of keys whose values are likely secrets.
// They err towards hiding too much: the API has no authentication, so a hidden
// harmless value costs a diff line while a leaked one costs a credential.
const secretKeyWords = `pass(word)?|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|` +
	`client[-_]?secret|credential|auth|cert|dsn|connection[-_]?string`

var (
	secretKeyPattern = regexp.MustCompile(`(?i)(` + secretKeyWords + `)`)
	// userinfoURLPattern matches a URL carrying credentials, such as a
	// database connection string, wherever it appears in a value.
	userinfoURLPattern = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*://[^/\s@]+@`)
	// embeddedAssignmentPattern matches a secret-looking assignment inside a
	// multi-line value, such as a config file embedded with a block scalar.
	embeddedAssignmentPattern = regexp.MustCompile(
		`(?im)^\s*["']?[\w.-]*(` + secretKeyWords + `)[\w.-]*["']?\s*[:=]\s*\S`)
)

// RedactValues hides secret-looking values in a values file while keeping its
// structure, so revisions can still be read and diffed. It returns the
// redacted YAML and the dotted path of every value it hid. A file that does
// not parse cannot be redacted reliably, so it is withheld entirely.
//
// Every parseable file is re-encoded, even one with nothing to hide, so two
// revisions diff by content rather than by formatting.
func RedactValues(valuesYAML string) (string, []string) {
	redactor := valuesRedactor{keys: []string{}}
	var documents []*yaml.Node
	decoder := yaml.NewDecoder(strings.NewReader(valuesYAML))
	for {
		var document yaml.Node
		err := decoder.Decode(&document)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", []string{"*"}
		}
		redactor.walk(&document, "", false)
		documents = append(documents, &document)
	}
	if len(documents) == 0 {
		return valuesYAML, redactor.keys
	}
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	for _, document := range documents {
		if err := encoder.Encode(document); err != nil {
			return "", []string{"*"}
		}
	}
	if err := encoder.Close(); err != nil {
		return "", []string{"*"}
	}
	return output.String(), redactor.keys
}

type valuesRedactor struct {
	keys []string
}

// walk visits node at path. hide is set below a secret-looking key, where
// every value is treated as secret: a `credentials:` block's contents are
// secrets whatever their own keys are called.
func (r *valuesRedactor) walk(node *yaml.Node, path string, hide bool) {
	switch node.Kind {
	case yaml.DocumentNode:
		for _, child := range node.Content {
			r.walk(child, path, hide)
		}
	case yaml.MappingNode:
		// Kubernetes env entries name the secret in a sibling key:
		// {name: DB_PASSWORD, value: hunter2}.
		hideValue := false
		for index := 0; index+1 < len(node.Content); index += 2 {
			key, value := node.Content[index], node.Content[index+1]
			if key.Value == "name" && value.Kind == yaml.ScalarNode && secretKeyPattern.MatchString(value.Value) {
				hideValue = true
			}
		}
		for index := 0; index+1 < len(node.Content); index += 2 {
			key, value := node.Content[index], node.Content[index+1]
			childHide := hide || secretKeyPattern.MatchString(key.Value) || (hideValue && key.Value == "value")
			r.walk(value, joinPath(path, key.Value), childHide)
		}
	case yaml.SequenceNode:
		for index, child := range node.Content {
			r.walk(child, path+"["+strconv.Itoa(index)+"]", hide)
		}
	case yaml.AliasNode:
		// An alias under a secret key would otherwise still point at the
		// secret's anchor, which is encoded in full where it is defined.
		if hide && node.Alias != nil {
			r.walk(node.Alias, path, true)
		}
	case yaml.ScalarNode:
		if r.secret(node, hide) {
			node.Value, node.Tag, node.Style = RedactedValue, "!!str", 0
			r.keys = append(r.keys, path)
		}
	}
}

func (r *valuesRedactor) secret(node *yaml.Node, hide bool) bool {
	if node.Value == RedactedValue {
		return false
	}
	if userinfoURLPattern.MatchString(node.Value) {
		return true
	}
	if strings.Contains(node.Value, "\n") && embeddedAssignmentPattern.MatchString(node.Value) {
		return true
	}
	// Flags and empty values reveal nothing, and hiding them would claim a
	// secret exists where there is none.
	switch node.ShortTag() {
	case "!!bool", "!!null":
		return false
	}
	return hide && node.Value != ""
}

func joinPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}
