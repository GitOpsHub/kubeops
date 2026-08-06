# OIDC Workload Identity Federation

Step-by-step setup for authenticating KubeOps to AWS, Google Cloud, and Azure
without storing a single long-lived credential.

This is the operator runbook. For the design rationale and the full claim
reference see [Keyless cloud access](../README.md#keyless-cloud-access) in the README, and
[CLAUDE.md](../CLAUDE.md) for the invariants the backend code depends on.

## How it works

The deployment platform (Vercel) mints a short-lived OIDC token that proves
*which project and environment* is running. Each cloud is configured to trust
that token's issuer and to map it onto a role, so KubeOps receives temporary
cloud credentials on every invocation.

```
Vercel function ---- OIDC token (JWT) ----+
                                          |
   AWS  <-- AssumeRoleWithWebIdentity -----+   -> temporary STS credentials
                                          |
   GCP  <-- STS token exchange ------------+   -> federated token, then
                                          |      service account impersonation
   Azure <- token as client assertion -----+   -> app registration access token
```

Nothing is cached. `backend/internal/cloudauth` re-reads the identity token on
every credential refresh, because the token is short-lived and a value captured
once would expire and then be replayed for the life of the process.

**The most important failure mode:** if federation is misconfigured, the code
does *not* error. `AWSConfig`, `GCPClientOptions`, and `AzureCredential` all fall back to the SDK
default credential chain when no token is available. In a deployed function that
chain finds nothing, so the sync succeeds and returns **zero clusters**. Silence
is the symptom — see [Troubleshooting](#troubleshooting).

## Prerequisites

Enable **Secure Backend Access with OIDC Federation** in the Vercel project
settings (Settings → Security). Until this is on, no token is minted and every
cloud step below is inert.

Then read the actual claims from the Vercel dashboard rather than assuming their
shape — the project name in `sub` is the Vercel project *slug*, which often
carries a suffix.

| Claim | Meaning | Worked example |
| --- | --- | --- |
| `iss` | Issuer. `https://oidc.vercel.com/<team-slug>` in **team** issuer mode, or `https://oidc.vercel.com` in **global** mode. | `https://oidc.vercel.com/kubeops` |
| `aud` | Audience. Always `https://vercel.com/<team-slug>`. | `https://vercel.com/kubeops` |
| `sub` | Subject. `owner:<team>:project:<project>:environment:<env>` | `owner:kubeops:project:kubeops-475j:environment:production` |

> **Why the default audience.** Both clouds' documentation recommends a custom
> `aud`. Vercel can only mint one through the `@vercel/oidc` npm helper, which a
> Go backend cannot use. KubeOps therefore presents the **default** audience, and
> each cloud must be configured to accept it explicitly.

`aud` is **team-wide**: every project in the Vercel team receives a token with
the identical audience. Only `sub` distinguishes one project from another, so
every trust rule below pins the exact `sub`.

Each environment (`production`, `preview`) is a distinct `sub` and therefore a
distinct trust entry. The examples below cover production only. To include
preview deployments, repeat the subject-scoped steps with
`environment:preview`.

---

## Part 1 — Amazon Web Services

Worked example: account `465532803838`, role `KubeOpsInventory`, region
`us-east-1`.

> The AWS setup in this repository was configured before this document was
> written; the steps below are reconstructed from the backend code and the
> README, not captured from a live `aws iam` read. Verify against the deployed
> role before relying on them for a new account.

### 1. Register the issuer as an IAM identity provider

This teaches IAM to verify tokens signed by Vercel. One per account, shared by
every role that trusts Vercel.

```bash
aws iam create-open-id-connect-provider --url https://oidc.vercel.com/kubeops --client-id-list https://vercel.com/kubeops
```

The `--client-id-list` value is the `aud` claim. Current AWS retrieves and pins
the issuer's certificate thumbprint automatically for publicly trusted issuers;
older CLI versions require an explicit `--thumbprint-list`.

### 2. Create the role with a subject-scoped trust policy

Save as `trust-policy.json`. Both conditions matter: `aud` alone is team-wide,
so `sub` is what actually restricts access to one project and environment.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::465532803838:oidc-provider/oidc.vercel.com/kubeops"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.vercel.com/kubeops:aud": "https://vercel.com/kubeops",
          "oidc.vercel.com/kubeops:sub": "owner:kubeops:project:kubeops-475j:environment:production"
        }
      }
    }
  ]
}
```

Use `StringEquals` for `sub`, not `StringLike` with a wildcard. A wildcard such
as `owner:kubeops:project:*` would trust every project in the Vercel team.

```bash
aws iam create-role --role-name KubeOpsInventory --assume-role-policy-document file://trust-policy.json
```

### 3. Attach read permissions

Scoped to exactly what `backend/internal/provider/aws.go` calls:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "eks:ListClusters",
        "eks:DescribeCluster",
        "eks:ListNodegroups",
        "eks:DescribeNodegroup"
      ],
      "Resource": "*"
    }
  ]
}
```

Add `eks:UpdateNodegroupConfig` only if node pool scaling is used — that is the
single mutating call, in `backend/internal/provider/operations.go`.

### 4. Configure the source

```yaml
  - id: aws-prod
    provider: aws
    name: AWS Production
    scope_id: "465532803838"
    regions: [us-east-1]
    enabled: true
    role_arn: arn:aws:iam::465532803838:role/KubeOpsInventory
```

`role_arn` is the field that switches federation on. Without it the source uses
the default credential chain even when a token is present.

Assumed-role sessions appear in CloudTrail as `kubeops-<source-id>`, derived
from the source id by `awsSessionName`.

---

## Part 2 — Google Cloud

Worked example: project `kubernetes-dev-502710`, project number
`369508662484`, service account `kubeops-inventory`.

Google's flow has one more hop than AWS: the token is exchanged for a federated
credential, which then **impersonates** a service account. Both halves must be
configured or nothing works.

### 1. Enable the required APIs

```bash
gcloud services enable sts.googleapis.com iamcredentials.googleapis.com iam.googleapis.com container.googleapis.com --project kubernetes-dev-502710
```

`sts.googleapis.com` performs the token exchange and `iamcredentials.googleapis.com`
performs the impersonation. Missing either one still builds a valid token source
at startup and only fails later, at the first refresh.

### 2. Create the workload identity pool

A pool is a namespace for external identities. It holds no trust configuration
itself and grants no access.

```bash
gcloud iam workload-identity-pools create kubeops --project=kubernetes-dev-502710 --location=global --display-name="KubeOps" --description="External identities for the KubeOps backend"
```

> Choose the name deliberately. Deleting a pool soft-deletes it for 30 days and
> the id stays reserved for that whole window.

### 3. Create the OIDC provider

This is the trust configuration.

```bash
gcloud iam workload-identity-pools providers create-oidc vercel --project=kubernetes-dev-502710 --location=global --workload-identity-pool=kubeops --display-name="Vercel" --issuer-uri="https://oidc.vercel.com/kubeops" --allowed-audiences="https://vercel.com/kubeops" --attribute-mapping="google.subject=assertion.sub" --attribute-condition="assertion.sub == 'owner:kubeops:project:kubeops-475j:environment:production'"
```

Three parts, each load-bearing:

- **`--issuer-uri`** — Google fetches this issuer's JWKS to verify signatures.
- **`--allowed-audiences`** — without it Google expects `aud` to be the
  provider's own resource name, which Vercel will not mint. This flag is what
  makes the default audience work.
- **`--attribute-mapping`** — `google.subject=assertion.sub` makes the Vercel
  subject the federated principal's identity, which step 4 then binds.

The `--attribute-condition` restricts the pool to one project and environment.
It is defence in depth alongside the binding below; because `aud` is team-wide,
without it the pool would admit every project in the Vercel team.

### 4. Grant impersonation on the service account

The provider decides who may *enter* the pool; it grants no access at all. This
binding is what lets the pool identity mint tokens for the service account.

```bash
gcloud iam service-accounts add-iam-policy-binding kubeops-inventory@kubernetes-dev-502710.iam.gserviceaccount.com --project=kubernetes-dev-502710 --role=roles/iam.workloadIdentityUser --member="principal://iam.googleapis.com/projects/369508662484/locations/global/workloadIdentityPools/kubeops/subject/owner:kubeops:project:kubeops-475j:environment:production"
```

The principal is `projects/<project-number>` — the number, not the id — followed
by the pool and the mapped subject. The colons inside the subject are part of
the identifier.

### 5. Grant the service account cluster read access

```bash
gcloud projects add-iam-policy-binding kubernetes-dev-502710 --member="serviceAccount:kubeops-inventory@kubernetes-dev-502710.iam.gserviceaccount.com" --role="roles/container.clusterViewer"
```

`backend/internal/provider/gcp.go` exposes only `Discover`, whose sole API call
is `ListClusters`. `roles/container.clusterViewer` covers that. The broader
`roles/container.viewer` also grants read on in-cluster objects that KubeOps
never reads. There is no GCP scaling path, so no write role is needed.

### 6. Configure the source

```yaml
  - id: gcp-kubernetes-dev
    provider: gcp
    name: Kubernetes Dev GCP
    scope_id: kubernetes-dev-502710
    regions: [us-east1]
    enabled: true
    workload_identity_provider: //iam.googleapis.com/projects/369508662484/locations/global/workloadIdentityPools/kubeops/providers/vercel
    impersonate_service_account: kubeops-inventory@kubernetes-dev-502710.iam.gserviceaccount.com
```

Both fields are required together — config validation rejects
`workload_identity_provider` without an impersonation target. Note the leading
`//` on the provider resource name.

Confirm the value rather than assembling it by hand:

```bash
gcloud iam workload-identity-pools providers describe vercel --project=kubernetes-dev-502710 --location=global --workload-identity-pool=kubeops --format='value(name)'
```

---

## Part 3 — Azure

Worked example: tenant `cdee03c3-580e-4a8b-a7c4-51156ba3835f`, subscription
`3df9adbd-ea55-4c92-964c-0252031979de`, app registration `kubeops-vercel`.

Azure is the shortest of the three. There is no pool and no impersonation hop:
the Vercel token is presented directly as a **client assertion** in place of a
client secret, against an app registration that lists the token's issuer and
subject as a federated credential.

### 1. Create the app registration

Skip if one already exists.

```bash
az ad app create --display-name kubeops-vercel
az ad sp create --id <appId>
```

The service principal is a separate object from the app registration and is the
one that holds role assignments. Both are required.

### 2. Add the federated identity credential

This single object is Azure's equivalent of GCP's provider plus attribute
condition — issuer, subject, and audience pinned together.

```bash
az ad app federated-credential create --id 72814df1-a644-4c2a-a58d-036ca4ecbc73 --parameters '{"name":"vercel-production","issuer":"https://oidc.vercel.com/kubeops","subject":"owner:kubeops:project:kubeops-475j:environment:production","audiences":["https://vercel.com/kubeops"]}'
```

Pass the **application (client) id**, not the object id.

- **The audience must be set explicitly.** Azure's default expected audience is
  `api://AzureADTokenExchange`, which Vercel will never mint.
- **Azure does not support partial claim matching.** `subject` must match the
  token exactly; wildcards are not accepted. Each environment therefore needs
  its own credential — add a second named `vercel-preview` with
  `environment:preview` to cover preview deployments.

Adding a federated credential does not disturb any existing client secret, so
this step is non-breaking: the app keeps authenticating by secret until the
config below switches it over.

### 3. Assign the subscription role

```bash
az role assignment create --assignee 72814df1-a644-4c2a-a58d-036ca4ecbc73 --role Reader --scope /subscriptions/3df9adbd-ea55-4c92-964c-0252031979de
```

`Reader` covers discovery: `backend/internal/provider/azure.go` lists managed
clusters and nothing more.

> **Scaling needs a second role.** Unlike GCP, Azure has a scaling path:
> `AgentPools.Get` and `AgentPools.BeginCreateOrUpdate` in
> `backend/internal/provider/operations.go`. `Reader` is read-only, so node pool
> scaling fails without an additional assignment. This is independent of
> federation and applies equally to secret-based auth.
>
> ```bash
> az role assignment create --assignee <appId> --role "Azure Kubernetes Service Agent Pool Manager Role" --scope /subscriptions/<subscription-id>
> ```
>
> `Azure Kubernetes Service Agent Pool Manager Role` grants exactly
> `managedClusters/agentPools/read` and `/write`, which is what those two calls
> need. Prefer it over `Azure Kubernetes Service Contributor Role`, which grants
> `Microsoft.ContainerService/managedClusters/*` — cluster deletion included.
> Note the `Role` suffix on both names; without it the CLI reports that the role
> does not exist.

### 4. Configure the source

```yaml
  - id: azure-subscription-1
    provider: azure
    name: Azure Subscription 1
    scope_id: 3df9adbd-ea55-4c92-964c-0252031979de
    regions: ["*"]
    enabled: true
    tenant_id: cdee03c3-580e-4a8b-a7c4-51156ba3835f
    client_id: 72814df1-a644-4c2a-a58d-036ca4ecbc73
```

`scope_id` is the subscription id; `client_id` is the app registration's
application id and is the field that switches federation on. Config validation
requires `tenant_id` alongside it.

### 5. Verify

```bash
az ad app federated-credential list --id 72814df1-a644-4c2a-a58d-036ca4ecbc73 --query '[].{name:name,issuer:issuer,subject:subject,audiences:audiences}' -o json
```

All four fields must match the token claims character for character.

---

## Part 4 — Deploy

### Environment variables

| Variable | Value | Notes |
| --- | --- | --- |
| `CLOUD_IDENTITY_MODE` | `auto` | Federates when a token is present, otherwise falls back to the SDK chains. `vercel` forces federation; `off` disables it. |
| `CLOUD_IDENTITY_AUDIENCE` | `https://vercel.com/<team-slug>` | Startup logging only. Does not affect the exchange, but surfaces drift early. |
| `CLOUD_SOURCES_YAML` | The full sources document | Required on serverless. |

`CLOUD_SOURCES_YAML` is the one that catches people out. The serverless
filesystem is read-only, so a deployed function reads this inline variable and
**not** `config/cloud-sources.yaml`. Editing the repo file alone changes nothing
in production — the two must be kept in step.

### Retire the static credentials

Once clusters are verified as arriving through federation, delete
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`, and `GOOGLE_APPLICATION_CREDENTIALS_JSON` from the
deployment. Leaving them in place means a federation regression is masked by a
silent fallback to static keys.

For Azure, also delete the client secret from the app registration itself —
removing the environment variable leaves the secret valid and usable:

```bash
az ad app credential list --id <appId> --query '[].{name:displayName,keyId:keyId,end:endDateTime}' -o json
az ad app credential delete --id <appId> --key-id <keyId>
```

Do this **after** verification, not alongside it — otherwise a failure has two
candidate causes.

---

## Verification

On cold start each enabled source logs its resolved mode:

```
cloud source credentials source=gcp-kubernetes-dev provider=gcp mode=federated audience=https://vercel.com/kubeops
```

**`mode=federated` is not proof that federation works.** `Config.FederationMode`
only checks that the relevant config field is non-empty and that a token source
resolves — and on Vercel one always resolves, because the `VERCEL` variable
alone is sufficient. The line would read `federated` even if the cloud rejected
every token. It confirms configuration, not authentication.

Real proof is clusters appearing after a sync. Trigger one and confirm the
expected clusters are present for each source.

## Troubleshooting

**Zero clusters, no error.** The signature failure mode. The credential builders
fell back to the default chain, which finds nothing in a keyless deployment, so
the provider returns an empty list successfully. Usual causes:

- `role_arn` / `workload_identity_provider` / `client_id` missing from the
  *deployed* `CLOUD_SOURCES_YAML`, even though the repo file has it
- `CLOUD_IDENTITY_MODE=off`
- A code path reaching a provider with `context.Background()` instead of the
  request context. A deployed function carries its token in the
  `x-vercel-oidc-token` request header, which `withIdentityToken` puts into the
  request context; without that context there is no token to find.

**`InvalidIdentityToken` / `sub` mismatch (AWS).** The trust policy's `sub` does
not match the token exactly. Check the Vercel project slug — `kubeops-475j`, not
`kubeops` — and the environment segment.

**`Unable to acquire impersonated credentials` (Google).** The exchange
succeeded but impersonation failed. Confirm step 4's binding exists on the
service account and that the principal uses the project **number**.

**`The given credential is rejected by the attribute condition` (Google).** The
token reached the provider but the `--attribute-condition` rejected it. Most
often a preview deployment hitting a production-only condition.

**`AADSTS70021: No matching federated identity record found` (Azure).** The
issuer, subject, or audience on the federated credential does not match the
token. Azure has no partial matching, so a single character of drift in `subject`
produces this. Compare with `az ad app federated-credential list`.

**`AADSTS700016` / app not found in directory (Azure).** `client_id` names an
app registration that has no service principal in the tenant. Create one with
`az ad sp create --id <appId>`.

**Azure clusters listed but scaling fails.** A permissions issue, not a
federation one — `Reader` cannot write. Assign `Azure Kubernetes Service Agent
Pool Manager Role` as shown in Part 3.

**Works in preview, fails in production (or vice versa).** Each environment is a
separate `sub` and needs its own trust entry on every cloud.

## Where the token comes from

Two routes, both handled:

- **Deployed functions** receive it as the `x-vercel-oidc-token` request header.
  `VERCEL_OIDC_TOKEN` is *not* set at runtime.
- **Builds and local development** receive it as the `VERCEL_OIDC_TOKEN`
  environment variable, which `vercel env pull` writes.

Because background workers have no request context, they can only federate from
the environment variable. That is consistent with `BACKGROUND_WORKERS`
defaulting to off on Vercel, where syncs run inside a request that carries the
header.

Token lifetimes are set by Vercel: one hour for build tokens, two hours for
`preview` and `production` function tokens, twelve hours for `development`.

## Local development

No setup is required. With no `VERCEL_OIDC_TOKEN` in the environment,
`cloudauth.Resolve` returns no token source and every provider falls back to its
default chain — `~/.aws`, `gcloud`, and `az` logins. Adding the federation
fields to `config/cloud-sources.yaml` does not change local behaviour.
