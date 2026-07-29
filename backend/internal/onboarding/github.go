package onboarding

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"gopkg.in/yaml.v3"
)

type ValuesRepository struct {
	Name         string
	URL          string
	CloneURL     string
	Revision     string
	CommitSHA    string
	ValuesYAML   string
	RegionValues map[string]bool
	Existing     bool
}

type ValuesUpdate struct {
	CommitSHA  string
	ValuesYAML string
}

type ValuesRepositoryManager interface {
	// Ensure creates the values repository or adopts it when it already exists.
	// Existing repositories are read without overwriting their values.
	Ensure(
		ctx context.Context,
		name, environment, baseValues string,
		regionValues map[string]string,
		targetRegions []string,
	) (ValuesRepository, error)
	// UpdateReplicas changes the release-scoped values file so Argo CD will
	// preserve the requested replica count instead of self-healing it away.
	UpdateReplicas(
		ctx context.Context,
		name, revision, environment, region string,
		replicas int32,
	) (ValuesUpdate, error)
}

type GitHubClient struct {
	apiURL         string
	organization   string
	visibility     string
	staticToken    string
	appID          int64
	installationID int64
	privateKey     *rsa.PrivateKey
	client         *http.Client
	mu             sync.Mutex
	token          string
	tokenExpiresAt time.Time
}

func NewGitHubClient(cfg config.OnboardingConfig) (*GitHubClient, error) {
	if cfg.GitHubToken != "" {
		return &GitHubClient{
			apiURL:       strings.TrimRight(cfg.GitHubAPIURL, "/"),
			organization: cfg.GitHubOrg,
			visibility:   cfg.GitHubVisibility,
			staticToken:  cfg.GitHubToken,
			client:       &http.Client{Timeout: cfg.RequestTimeout},
		}, nil
	}
	if cfg.GitHubAppID == 0 && cfg.GitHubInstallID == 0 && cfg.GitHubKeyFile == "" {
		return nil, nil
	}
	if cfg.GitHubAppID == 0 || cfg.GitHubInstallID == 0 || cfg.GitHubKeyFile == "" {
		return nil, errors.New("GitHub App ID, installation ID, and private key file must be configured together")
	}
	keyPEM, err := os.ReadFile(cfg.GitHubKeyFile)
	if err != nil {
		return nil, fmt.Errorf("read GitHub App private key: %w", err)
	}
	privateKey, err := parsePrivateKey(keyPEM)
	if err != nil {
		return nil, err
	}
	return &GitHubClient{
		apiURL:         strings.TrimRight(cfg.GitHubAPIURL, "/"),
		organization:   cfg.GitHubOrg,
		visibility:     cfg.GitHubVisibility,
		appID:          cfg.GitHubAppID,
		installationID: cfg.GitHubInstallID,
		privateKey:     privateKey,
		client:         &http.Client{Timeout: cfg.RequestTimeout},
	}, nil
}

func parsePrivateKey(keyPEM []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, errors.New("GitHub App private key is not valid PEM")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("GitHub App private key is not valid PKCS#1 or PKCS#8")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("GitHub App private key must be RSA")
	}
	return key, nil
}

func (c *GitHubClient) Ensure(
	ctx context.Context,
	name, environment, valuesYAML string,
	regionValues map[string]string,
	targetRegions []string,
) (ValuesRepository, error) {
	token, err := c.authenticationToken(ctx)
	if err != nil {
		return ValuesRepository{}, err
	}
	var repository struct {
		Name          string `json:"name"`
		HTMLURL       string `json:"html_url"`
		CloneURL      string `json:"clone_url"`
		DefaultBranch string `json:"default_branch"`
	}
	status, err := c.request(ctx, token, http.MethodPost,
		"/orgs/"+url.PathEscape(c.organization)+"/repos",
		map[string]any{
			"name":        name,
			"description": "GitOps values for the " + name + " application",
			"private":     c.visibility == "private",
			"visibility":  c.visibility,
			"auto_init":   true,
		},
		&repository,
	)
	if status == http.StatusUnprocessableEntity {
		return c.loadExisting(
			ctx, token, name, environment, valuesYAML, regionValues, targetRegions,
		)
	}
	if err != nil {
		return ValuesRepository{}, err
	}
	if repository.DefaultBranch == "" {
		repository.DefaultBranch = "main"
	}

	var commitSHA string
	regions := uniqueStrings(targetRegions)
	sort.Strings(regions)
	for _, region := range regions {
		scopedValues, mergeErr := mergeValuesYAML(valuesYAML, regionValues[region])
		if mergeErr != nil {
			return ValuesRepository{}, fmt.Errorf("merge %s/%s values: %w", environment, region, mergeErr)
		}
		var regionCommit struct {
			Commit struct {
				SHA string `json:"sha"`
			} `json:"commit"`
		}
		_, err = c.request(ctx, token, http.MethodPut,
			"/repos/"+url.PathEscape(c.organization)+"/"+url.PathEscape(name)+
				"/contents/"+url.PathEscape(environment)+"/"+url.PathEscape(region)+"/values.yaml",
			map[string]any{
				"message": "Add " + environment + "/" + region + " Helm values",
				"content": base64.StdEncoding.EncodeToString([]byte(scopedValues)),
				"branch":  repository.DefaultBranch,
			},
			&regionCommit,
		)
		if err != nil {
			return ValuesRepository{}, fmt.Errorf(
				"create %s/%s/values.yaml: %w", environment, region, err,
			)
		}
		commitSHA = regionCommit.Commit.SHA
	}
	return ValuesRepository{
		Name: repository.Name, URL: repository.HTMLURL, CloneURL: repository.CloneURL,
		Revision: repository.DefaultBranch, CommitSHA: commitSHA,
		ValuesYAML: valuesYAML, RegionValues: regionSet(regions),
	}, nil
}

func (c *GitHubClient) loadExisting(
	ctx context.Context,
	token, name, environment string,
	baseValues string,
	regionValues map[string]string,
	targetRegions []string,
) (ValuesRepository, error) {
	var repository struct {
		Name          string `json:"name"`
		HTMLURL       string `json:"html_url"`
		CloneURL      string `json:"clone_url"`
		DefaultBranch string `json:"default_branch"`
	}
	repositoryPath := "/repos/" + url.PathEscape(c.organization) + "/" + url.PathEscape(name)
	if _, err := c.request(ctx, token, http.MethodGet, repositoryPath, nil, &repository); err != nil {
		return ValuesRepository{}, fmt.Errorf("load existing values repository: %w", err)
	}
	if repository.DefaultBranch == "" {
		repository.DefaultBranch = "main"
	}

	var valuesFile struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	var commit struct {
		SHA string `json:"sha"`
	}
	commitPath := repositoryPath + "/commits/" + url.PathEscape(repository.DefaultBranch)
	if _, err := c.request(ctx, token, http.MethodGet, commitPath, nil, &commit); err != nil {
		return ValuesRepository{}, fmt.Errorf("load existing values commit: %w", err)
	}

	regions := make(map[string]bool)
	var valuesYAML []byte
	for _, region := range uniqueStrings(targetRegions) {
		path := repositoryPath + "/contents/" + url.PathEscape(environment) + "/" +
			url.PathEscape(region) +
			"/values.yaml?ref=" + url.QueryEscape(repository.DefaultBranch)
		var scopedFile struct {
			Encoding string `json:"encoding"`
			Content  string `json:"content"`
		}
		status, requestErr := c.request(ctx, token, http.MethodGet, path, nil, &scopedFile)
		if status == http.StatusNotFound {
			scopedValues, mergeErr := mergeValuesYAML(baseValues, regionValues[region])
			if mergeErr != nil {
				return ValuesRepository{}, fmt.Errorf(
					"merge %s/%s values: %w", environment, region, mergeErr,
				)
			}
			var regionCommit struct {
				Commit struct {
					SHA string `json:"sha"`
				} `json:"commit"`
			}
			_, createErr := c.request(
				ctx, token, http.MethodPut,
				strings.Split(path, "?")[0],
				map[string]any{
					"message": "Add " + environment + "/" + region + " Helm values",
					"content": base64.StdEncoding.EncodeToString([]byte(scopedValues)),
					"branch":  repository.DefaultBranch,
				},
				&regionCommit,
			)
			if createErr != nil {
				return ValuesRepository{}, fmt.Errorf(
					"create %s/%s/values.yaml: %w", environment, region, createErr,
				)
			}
			commit.SHA = regionCommit.Commit.SHA
			if valuesYAML == nil {
				valuesYAML = []byte(scopedValues)
			}
			regions[region] = true
			continue
		}
		if requestErr != nil {
			return ValuesRepository{}, fmt.Errorf(
				"check existing %s/%s values: %w", environment, region, requestErr,
			)
		}
		if scopedFile.Encoding != "base64" {
			return ValuesRepository{}, errors.New("existing scoped values file uses an unsupported encoding")
		}
		decoded, decodeErr := base64.StdEncoding.DecodeString(scopedFile.Content)
		if decodeErr != nil {
			return ValuesRepository{}, errors.New("existing scoped values file is not valid base64")
		}
		if valuesYAML == nil {
			valuesYAML = decoded
		}
		regions[region] = true
	}
	if valuesYAML == nil {
		valuesPath := repositoryPath + "/contents/values.yaml?ref=" +
			url.QueryEscape(repository.DefaultBranch)
		if _, err := c.request(ctx, token, http.MethodGet, valuesPath, nil, &valuesFile); err != nil {
			return ValuesRepository{}, fmt.Errorf("load existing values.yaml: %w", err)
		}
		if valuesFile.Encoding != "base64" {
			return ValuesRepository{}, errors.New("existing values.yaml uses an unsupported encoding")
		}
		decoded, decodeErr := base64.StdEncoding.DecodeString(valuesFile.Content)
		if decodeErr != nil {
			return ValuesRepository{}, errors.New("existing values.yaml is not valid base64")
		}
		valuesYAML = decoded
	}

	return ValuesRepository{
		Name: repository.Name, URL: repository.HTMLURL, CloneURL: repository.CloneURL,
		Revision: repository.DefaultBranch, CommitSHA: commit.SHA,
		ValuesYAML: string(valuesYAML), RegionValues: regions, Existing: true,
	}, nil
}

func (c *GitHubClient) UpdateReplicas(
	ctx context.Context,
	name, revision, environment, region string,
	replicas int32,
) (ValuesUpdate, error) {
	token, err := c.authenticationToken(ctx)
	if err != nil {
		return ValuesUpdate{}, err
	}
	repositoryPath := "/repos/" + url.PathEscape(c.organization) + "/" + url.PathEscape(name)
	contentPath := repositoryPath + "/contents/" + url.PathEscape(environment) + "/" +
		url.PathEscape(region) + "/values.yaml"
	var file struct {
		SHA      string `json:"sha"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if _, err := c.request(
		ctx, token, http.MethodGet,
		contentPath+"?ref="+url.QueryEscape(revision), nil, &file,
	); err != nil {
		return ValuesUpdate{}, fmt.Errorf("load %s/%s values: %w", environment, region, err)
	}
	if file.Encoding != "base64" {
		return ValuesUpdate{}, errors.New("release values file uses an unsupported encoding")
	}
	decoded, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil {
		return ValuesUpdate{}, errors.New("release values file is not valid base64")
	}
	var values map[string]any
	if err := yaml.Unmarshal(decoded, &values); err != nil {
		return ValuesUpdate{}, fmt.Errorf("decode release values: %w", err)
	}
	if values == nil {
		values = make(map[string]any)
	}
	values["replicaCount"] = replicas
	updatedValues, err := yaml.Marshal(values)
	if err != nil {
		return ValuesUpdate{}, fmt.Errorf("encode release values: %w", err)
	}
	var commit struct {
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	if _, err := c.request(ctx, token, http.MethodPut, contentPath, map[string]any{
		"message": fmt.Sprintf(
			"Scale %s/%s to %d replicas", environment, region, replicas,
		),
		"content": base64.StdEncoding.EncodeToString(updatedValues),
		"branch":  revision,
		"sha":     file.SHA,
	}, &commit); err != nil {
		return ValuesUpdate{}, fmt.Errorf("update %s/%s replicas: %w", environment, region, err)
	}
	return ValuesUpdate{CommitSHA: commit.Commit.SHA, ValuesYAML: string(updatedValues)}, nil
}

func mergeValuesYAML(baseValues, overrideValues string) (string, error) {
	if strings.TrimSpace(overrideValues) == "" {
		return baseValues, nil
	}
	var base map[string]any
	var override map[string]any
	if err := yaml.Unmarshal([]byte(baseValues), &base); err != nil {
		return "", err
	}
	if err := yaml.Unmarshal([]byte(overrideValues), &override); err != nil {
		return "", err
	}
	mergeValueMaps(base, override)
	merged, err := yaml.Marshal(base)
	return string(merged), err
}

func mergeValueMaps(base, override map[string]any) {
	for key, value := range override {
		overrideMap, overrideIsMap := value.(map[string]any)
		baseMap, baseIsMap := base[key].(map[string]any)
		if overrideIsMap && baseIsMap {
			mergeValueMaps(baseMap, overrideMap)
			continue
		}
		base[key] = value
	}
}

func regionSet(regions []string) map[string]bool {
	result := make(map[string]bool, len(regions))
	for _, region := range regions {
		result[region] = true
	}
	return result
}

func regionKeys(values map[string]string) map[string]bool {
	regions := make(map[string]bool, len(values))
	for region := range values {
		regions[region] = true
	}
	return regions
}

func (c *GitHubClient) authenticationToken(ctx context.Context) (string, error) {
	if c.staticToken != "" {
		return c.staticToken, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Until(c.tokenExpiresAt) > time.Minute {
		return c.token, nil
	}
	jwt, err := c.appJWT(time.Now())
	if err != nil {
		return "", err
	}
	var response struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	_, err = c.request(ctx, jwt, http.MethodPost,
		"/app/installations/"+strconv.FormatInt(c.installationID, 10)+"/access_tokens",
		map[string]any{}, &response)
	if err != nil {
		return "", fmt.Errorf("create GitHub App installation token: %w", err)
	}
	if response.Token == "" {
		return "", errors.New("GitHub App installation token response was empty")
	}
	c.token, c.tokenExpiresAt = response.Token, response.ExpiresAt
	return c.token, nil
}

func (c *GitHubClient) appJWT(now time.Time) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payloadBytes, err := json.Marshal(map[string]any{
		"iat": now.Add(-time.Minute).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": c.appID,
	})
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	unsigned := header + "." + payload
	digest := crypto.SHA256.New()
	_, _ = digest.Write([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, c.privateKey, crypto.SHA256, digest.Sum(nil))
	if err != nil {
		return "", fmt.Errorf("sign GitHub App JWT: %w", err)
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (c *GitHubClient) request(
	ctx context.Context,
	token, method, path string,
	payload any,
	result any,
) (int, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.apiURL+path, body)
	if err != nil {
		return 0, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return response.StatusCode, fmt.Errorf("GitHub API returned status %d", response.StatusCode)
	}
	if result == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return response.StatusCode, nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(result); err != nil {
		return response.StatusCode, fmt.Errorf("decode GitHub API response: %w", err)
	}
	return response.StatusCode, nil
}
