package onboarding

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

var (
	// ErrRevisionNotFound reports that GitHub has no values file at the
	// requested commit.
	ErrRevisionNotFound = errors.New("values revision not found")
	// ErrValuesUnchanged reports a rollback to content identical to what the
	// branch already holds, which GitHub would record as an empty commit.
	ErrValuesUnchanged = errors.New("values are unchanged")
)

// ValuesCommit is one commit that touched a release values file.
type ValuesCommit struct {
	SHA         string     `json:"sha"`
	Message     string     `json:"message"`
	Author      string     `json:"author"`
	CommittedAt *time.Time `json:"committedAt"`
	URL         string     `json:"url"`
	Current     bool       `json:"current"`
}

// releaseValuesPath is the file Argo CD reads for a release context; the
// Application's valueFiles entry and every values write use the same layout.
func releaseValuesPath(environment, region string) string {
	return environment + "/" + region + "/values.yaml"
}

// escapedContentPath escapes each segment of a repository path while keeping
// the separators GitHub's contents API expects.
func escapedContentPath(filePath string) string {
	segments := strings.Split(filePath, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

// ValuesHistory lists the newest commits on branch that changed filePath.
// The first entry is marked current: its content is what the branch head, and
// therefore Argo CD, serves for that file.
func (c *GitHubClient) ValuesHistory(
	ctx context.Context,
	name, branch, filePath string,
	limit int,
) ([]ValuesCommit, error) {
	token, err := c.authenticationToken(ctx)
	if err != nil {
		return nil, err
	}
	query := url.Values{
		"sha":      []string{branch},
		"path":     []string{filePath},
		"per_page": []string{strconv.Itoa(limit)},
	}
	var commits []struct {
		SHA     string `json:"sha"`
		HTMLURL string `json:"html_url"`
		Commit  struct {
			Message string `json:"message"`
			Author  struct {
				Name string     `json:"name"`
				Date *time.Time `json:"date"`
			} `json:"author"`
			Committer struct {
				Date *time.Time `json:"date"`
			} `json:"committer"`
		} `json:"commit"`
		Author *struct {
			Login string `json:"login"`
		} `json:"author"`
	}
	status, err := c.request(ctx, token, http.MethodGet,
		"/repos/"+url.PathEscape(c.organization)+"/"+url.PathEscape(name)+"/commits?"+query.Encode(),
		nil, &commits)
	if status == http.StatusNotFound || status == http.StatusConflict {
		// 404: repository or branch is gone; 409: the repository is empty.
		return []ValuesCommit{}, nil
	}
	if err != nil {
		return nil, err
	}
	history := make([]ValuesCommit, 0, len(commits))
	for index, commit := range commits {
		author := commit.Commit.Author.Name
		if author == "" && commit.Author != nil {
			author = commit.Author.Login
		}
		committedAt := commit.Commit.Committer.Date
		if committedAt == nil {
			committedAt = commit.Commit.Author.Date
		}
		subject, _, _ := strings.Cut(commit.Commit.Message, "\n")
		history = append(history, ValuesCommit{
			SHA: commit.SHA, Message: strings.TrimSpace(subject), Author: author,
			CommittedAt: committedAt, URL: commit.HTMLURL, Current: index == 0,
		})
	}
	return history, nil
}

type contentsFile struct {
	SHA      string `json:"sha"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

func (c *GitHubClient) readFile(
	ctx context.Context,
	token, name, filePath, ref string,
) (contentsFile, []byte, error) {
	var file contentsFile
	status, err := c.request(ctx, token, http.MethodGet,
		"/repos/"+url.PathEscape(c.organization)+"/"+url.PathEscape(name)+
			"/contents/"+escapedContentPath(filePath)+"?ref="+url.QueryEscape(ref),
		nil, &file)
	if status == http.StatusNotFound || status == http.StatusUnprocessableEntity {
		return contentsFile{}, nil, ErrRevisionNotFound
	}
	if err != nil {
		return contentsFile{}, nil, err
	}
	if file.Encoding != "base64" {
		return contentsFile{}, nil, errors.New("values file uses an unsupported encoding")
	}
	decoded, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil {
		return contentsFile{}, nil, errors.New("values file is not valid base64")
	}
	return file, decoded, nil
}

// ValuesAt returns filePath as it was at ref.
func (c *GitHubClient) ValuesAt(ctx context.Context, name, filePath, ref string) (string, error) {
	token, err := c.authenticationToken(ctx)
	if err != nil {
		return "", err
	}
	_, content, err := c.readFile(ctx, token, name, filePath, ref)
	return string(content), err
}

// RestoreValues commits filePath's content at sha on top of branch. It is a
// forward commit, not a history rewrite, so Argo CD simply deploys the new
// head and the rollback itself stays auditable in Git.
func (c *GitHubClient) RestoreValues(
	ctx context.Context,
	name, branch, filePath, sha string,
) (ValuesUpdate, error) {
	token, err := c.authenticationToken(ctx)
	if err != nil {
		return ValuesUpdate{}, err
	}
	_, target, err := c.readFile(ctx, token, name, filePath, sha)
	if err != nil {
		return ValuesUpdate{}, fmt.Errorf("load values at %s: %w", shortSHA(sha), err)
	}
	current, content, err := c.readFile(ctx, token, name, filePath, branch)
	if err != nil {
		return ValuesUpdate{}, fmt.Errorf("load current values: %w", err)
	}
	if string(content) == string(target) {
		return ValuesUpdate{}, ErrValuesUnchanged
	}
	var commit struct {
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	if _, err := c.request(ctx, token, http.MethodPut,
		"/repos/"+url.PathEscape(c.organization)+"/"+url.PathEscape(name)+
			"/contents/"+escapedContentPath(filePath),
		map[string]any{
			"message": fmt.Sprintf("Roll back %s values to %s", path.Dir(filePath), shortSHA(sha)),
			"content": base64.StdEncoding.EncodeToString(target),
			"branch":  branch,
			// The current blob SHA makes GitHub refuse the write if the file
			// changed since it was read, instead of silently overwriting it.
			"sha": current.SHA,
		}, &commit); err != nil {
		return ValuesUpdate{}, fmt.Errorf("commit rolled back values: %w", err)
	}
	return ValuesUpdate{CommitSHA: commit.Commit.SHA, ValuesYAML: string(target)}, nil
}

func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
