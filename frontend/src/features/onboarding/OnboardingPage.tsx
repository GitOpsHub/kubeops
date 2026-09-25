import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, errorMessage } from '../../api/client'
import type { Cluster } from '../../api/inventory'
import {
  createApplicationOnboarding,
  getOnboardingClusters,
  getOnboardingDefaults,
} from '../../api/onboarding'
import { ProviderLogo } from '../../components/BrandIcons'
import { ChevronLeftIcon, ChevronRightIcon, DeployIcon } from '../../components/icons'
import { Banner } from '../../components/ui/Banner'
import { Button } from '../../components/ui/Button'
import { Field, Select, TextInput } from '../../components/ui/Field'
import { KeyValueList } from '../../components/ui/KeyValueList'
import { PageHeader } from '../../components/ui/PageHeader'
import { Stepper } from '../../components/ui/Stepper'
import { useToast } from '../../components/ui/toast-context'
import { usePolledResource } from '../../hooks/usePolledResource'
import { plural } from '../../lib/format'
import { plannedResources } from './onboarding-plan'
import {
  clearDraft,
  clusterInRegion,
  deploymentScope,
  emptyDraft,
  fieldSteps,
  firstInvalidStep,
  hasDraftContent,
  loadDraft,
  maxNameLength,
  saveDraft,
  scopeChoices,
  serverErrorField,
  stepIndex,
  validateStep,
  wizardSteps,
  type FieldErrors,
  type FieldId,
  type StepId,
  type WizardDraft,
} from './onboarding-wizard'
import { PlanPreview, ResourcePlanTable } from './ResourcePlan'
import { TargetPicker, targetsErrorId } from './TargetPicker'
import { ValuesEditor } from './ValuesEditor'
import './onboarding.css'

// Where focus goes when a field needs attention. Targets has no single
// control, so its search box is the nearest useful stop.
const fieldControlIds: Record<FieldId, string> = {
  name: 'onboarding-name',
  environment: 'onboarding-environment',
  region: 'onboarding-region',
  clusters: 'onboarding-targets-anchor',
  values: 'onboarding-values',
}

const environmentNotes: Record<string, string> = {
  dev: 'Development: fast iteration, no approval gate.',
  qa: 'Quality assurance: mirrors production for verification.',
  prod: 'Production: changes reach customer traffic once synced.',
}

function initialDraft() {
  const stored = loadDraft()
  if (!stored) return { draft: emptyDraft(), restored: false }
  // Resume where the operator was, but never past a step that is not valid.
  const invalid = firstInvalidStep(stored)
  const step = invalid && stepIndex(invalid) < stepIndex(stored.step) ? invalid : stored.step
  return { draft: { ...stored, step }, restored: hasDraftContent(stored) }
}

/** The backend's messages start lower-case; a field error reads as a sentence. */
function sentence(message: string) {
  const trimmed = message.trim()
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`
}

function firstField(errors: FieldErrors) {
  return (Object.keys(fieldSteps) as FieldId[]).find((field) => errors[field])
}

/**
 * Onboarding as five short steps. Each step validates before the next opens,
 * the plan of generated resources follows the operator as they type, and the
 * draft survives a reload for the rest of the tab's session.
 */
export function OnboardingPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [initial] = useState(initialDraft)
  const [draft, setDraft] = useState<WizardDraft>(initial.draft)
  const [restored, setRestored] = useState(initial.restored)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocus = useRef<string | null>(null)
  const focusedStep = useRef(initial.draft.step)

  const loadClusters = useCallback(async (signal: AbortSignal) => {
    const clusters = await getOnboardingClusters(signal)
    return clusters.filter((cluster) => !cluster.removedAt)
  }, [])
  const clustersQuery = usePolledResource(loadClusters)
  const loadDefaults = useCallback((signal: AbortSignal) => getOnboardingDefaults(signal), [])
  const defaultsQuery = usePolledResource(loadDefaults)
  const defaults = defaultsQuery.data
  const { environments, regions } = scopeChoices(defaults)

  // The base values are not editable during onboarding: the chart defaults are
  // submitted as-is, so an empty string means they have not loaded.
  const valuesYaml = defaults?.valuesYaml ?? ''

  const { name, environment, region, step } = draft
  const scope = deploymentScope(environment, region)
  const current = wizardSteps[stepIndex(step)]
  const currentIndex = stepIndex(step)

  // A draft or an older default can name a scope the API no longer offers.
  useEffect(() => {
    if (!defaults) return
    setDraft((currentDraft) => {
      const next = { ...currentDraft }
      if (!environments.includes(next.environment)) next.environment = environments[0]
      if (!regions.includes(next.region)) next.region = regions[0]
      return next.environment === currentDraft.environment && next.region === currentDraft.region
        ? currentDraft
        : next
    })
    // The lists are derived from `defaults`; depending on it alone avoids a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults])

  // A restored selection can outlive a cluster that has since been removed.
  useEffect(() => {
    const clusters = clustersQuery.data
    if (!clusters) return
    const known = new Set(clusters.map((cluster) => cluster.id))
    setDraft((currentDraft) =>
      currentDraft.clusterIds.every((id) => known.has(id))
        ? currentDraft
        : { ...currentDraft, clusterIds: currentDraft.clusterIds.filter((id) => known.has(id)) },
    )
  }, [clustersQuery.data])

  useEffect(() => saveDraft(draft), [draft])

  // Moving between steps puts the keyboard on the new step's heading, or on
  // the field that sent the operator back.
  useEffect(() => {
    // Compared with the last step rather than a mount flag, which StrictMode's
    // double effect would defeat and steal focus on first load.
    if (focusedStep.current === step) return
    focusedStep.current = step
    const target = pendingFocus.current
    pendingFocus.current = null
    const element = target ? document.getElementById(target) : headingRef.current
    element?.focus()
  }, [step])

  const sortedClusters = useMemo(
    () =>
      [...(clustersQuery.data ?? [])].sort(
        (a, b) =>
          a.sourceName.localeCompare(b.sourceName) ||
          a.location.localeCompare(b.location) ||
          a.name.localeCompare(b.name),
      ),
    [clustersQuery.data],
  )
  const clusterById = useMemo(
    () => new Map(sortedClusters.map((cluster) => [cluster.id, cluster])),
    [sortedClusters],
  )
  const selectedClusters = draft.clusterIds
    .map((id) => clusterById.get(id))
    .filter((cluster): cluster is Cluster => Boolean(cluster))
  const regionClusterCount = sortedClusters.filter((cluster) =>
    clusterInRegion(cluster, region),
  ).length

  const nameAccepted = Object.keys(validateStep('application', draft)).length === 0
  const resourcePlan = useMemo(
    () =>
      nameAccepted
        ? plannedResources(
            name,
            environment,
            region,
            valuesYaml,
            defaults?.valuesRepositoryBaseUrl ?? '',
            defaults?.valuesRevision ?? '',
          )
        : null,
    [defaults, environment, name, nameAccepted, region, valuesYaml],
  )

  function update(patch: Partial<WizardDraft>, fields: FieldId[] = []) {
    setDraft((currentDraft) => ({ ...currentDraft, ...patch }))
    if (fields.length > 0) {
      setErrors((currentErrors) => {
        const next = { ...currentErrors }
        for (const field of fields) delete next[field]
        return next
      })
    }
    setFormError('')
  }

  function goTo(target: StepId, focusField?: FieldId) {
    pendingFocus.current = focusField ? fieldControlIds[focusField] : null
    if (target === step && focusField) {
      document.getElementById(fieldControlIds[focusField])?.focus()
    }
    setDraft((currentDraft) => ({ ...currentDraft, step: target }))
  }

  function showErrors(stepErrors: FieldErrors, target: StepId) {
    setErrors((currentErrors) => ({ ...currentErrors, ...stepErrors }))
    goTo(target, firstField(stepErrors))
  }

  function next() {
    const stepErrors = validateStep(step, draft)
    if (Object.keys(stepErrors).length > 0) {
      showErrors(stepErrors, step)
      return
    }
    goTo(wizardSteps[currentIndex + 1].id)
  }

  function back() {
    if (currentIndex > 0) goTo(wizardSteps[currentIndex - 1].id)
  }

  function startOver() {
    clearDraft()
    setDraft(emptyDraft(environments[0], regions[0]))
    setErrors({})
    setFormError('')
    setRestored(false)
  }

  async function onboard() {
    const invalid = firstInvalidStep(draft)
    if (invalid) {
      showErrors(validateStep(invalid, draft), invalid)
      return
    }
    if (!valuesYaml.trim()) {
      setFormError('Helm chart defaults could not be loaded. Reload the page and try again.')
      return
    }
    setSubmitting(true)
    try {
      const activeRegions = draft.clusterIds.length > 0 ? [region] : []
      const overrides: Record<string, string> = {}
      for (const item of activeRegions) {
        const override = draft.regionValues[item]
        if (override && override.trim()) overrides[item] = override
      }
      // Key order is part of the contract; the backend's request log and the
      // tests compare the body byte for byte.
      const record = await createApplicationOnboarding({
        name,
        namespace: name,
        environment,
        region,
        clusterIds: draft.clusterIds,
        valuesYaml,
        regionValues: overrides,
      })
      clearDraft()
      toast.success(`${name} onboarding started`, {
        description: `Deploying to ${plural(draft.clusterIds.length, 'cluster')} in ${scope}.`,
      })
      // Deployment may still be progressing; the detail route polls until it settles.
      void navigate(`/applications/${record.id}`)
    } catch (submitError) {
      const message = errorMessage(submitError, 'Application could not be onboarded')
      const field =
        submitError instanceof ApiError ? serverErrorField(submitError.status, message) : null
      if (field) {
        showErrors({ [field]: sentence(message) }, fieldSteps[field])
      } else {
        setFormError(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    if (step === 'review') void onboard()
    else next()
  }

  const defaultsError = defaultsQuery.error?.message ?? ''
  const override = draft.regionValues[region] ?? ''
  const overrideCount = override.trim() ? 1 : 0

  return (
    <section className="page" aria-labelledby="onboarding-heading">
      <PageHeader
        id="onboarding-heading"
        back={{ to: '/applications', label: 'Applications' }}
        title="Onboard an application"
        description="Define the release, choose exactly where it runs, and check what it will create."
      />

      {restored && (
        <Banner
          tone="info"
          title="Draft restored"
          onDismiss={() => setRestored(false)}
          onRetry={startOver}
          retryLabel="Start over"
        >
          Picked up the onboarding you started earlier in this tab.
        </Banner>
      )}
      {defaultsError && (
        <Banner
          tone="error"
          title="Onboarding data is unavailable"
          onRetry={() => void defaultsQuery.reload()}
        >
          {defaultsError}
        </Banner>
      )}
      {formError && (
        <Banner tone="error" title="Onboarding cannot continue">
          {formError}
        </Banner>
      )}

      <div className="wizard">
        <div className="wizard-progress">
          <Stepper
            steps={wizardSteps.map(({ id, label }) => ({ id, label }))}
            current={step}
            onStepSelect={(id) => goTo(id as StepId)}
          />
        </div>

        <div
          className={step === 'review' ? 'wizard-layout wizard-layout--review' : 'wizard-layout'}
        >
          <form
            className="wizard-panel"
            aria-labelledby="wizard-step-title"
            noValidate
            onSubmit={submit}
          >
            <header className="wizard-panel-header">
              <p className="wizard-kicker">
                Step {currentIndex + 1} of {wizardSteps.length}
                <span aria-hidden="true"> · {current.label}</span>
              </p>
              <h2 id="wizard-step-title" ref={headingRef} tabIndex={-1}>
                {current.title}
              </h2>
              <p>{current.description}</p>
            </header>

            <div className="wizard-panel-body" key={step}>
              {step === 'application' && (
                <>
                  <Field
                    id={fieldControlIds.name}
                    label="Application name"
                    error={errors.name}
                    hint={`Lowercase letters, digits, and hyphens; up to ${maxNameLength(environment, region)} characters.`}
                  >
                    <TextInput
                      className="mono"
                      type="text"
                      value={name}
                      maxLength={maxNameLength(environment, region)}
                      placeholder="payments-api"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => update({ name: event.target.value }, ['name'])}
                    />
                  </Field>
                  <div className="derived-identity">
                    <p className="derived-identity-title">Derived from the name</p>
                    <KeyValueList
                      items={[
                        {
                          label: 'Kubernetes namespace',
                          value: name ? `${name}-${scope}` : '',
                          mono: true,
                        },
                        {
                          label: 'Argo CD application',
                          value: name ? `${name}-${scope}` : '',
                          mono: true,
                        },
                        {
                          label: 'Values repository',
                          value:
                            name && defaults?.valuesRepositoryBaseUrl
                              ? `${defaults.valuesRepositoryBaseUrl.replace(/\/+$/, '')}/${name}`
                              : '',
                          mono: true,
                        },
                      ]}
                    />
                    <p className="subtle">
                      Suffixed with <span className="mono">{scope}</span>, which you can change in
                      the next step.
                    </p>
                  </div>
                </>
              )}

              {step === 'scope' && (
                <>
                  <div className="wizard-fields">
                    <Field
                      id={fieldControlIds.environment}
                      label="Environment"
                      error={errors.environment}
                      hint={environmentNotes[environment]}
                    >
                      <Select
                        value={environment}
                        onChange={(event) =>
                          update({ environment: event.target.value }, ['environment', 'name'])
                        }
                      >
                        {environments.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      id={fieldControlIds.region}
                      label="Region"
                      error={errors.region}
                      hint={`${plural(regionClusterCount, 'cluster')} available in ${region}.`}
                    >
                      <Select
                        value={region}
                        onChange={(event) =>
                          update({ region: event.target.value }, ['region', 'environment', 'name'])
                        }
                      >
                        {regions.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div
                    className="scope-preview"
                    data-tone={environment === 'prod' ? 'warn' : 'info'}
                  >
                    <KeyValueList
                      items={[
                        { label: 'Deployment scope', value: scope, mono: true },
                        { label: 'Release', value: name ? `${name}-${scope}` : '', mono: true },
                        {
                          label: 'Values file',
                          value: `${environment}/${region}/values.yaml`,
                          mono: true,
                        },
                      ]}
                    />
                  </div>
                </>
              )}

              {step === 'targets' && (
                <>
                  <span id={fieldControlIds.clusters} tabIndex={-1} className="sr-only">
                    Target clusters
                  </span>
                  <TargetPicker
                    clusters={sortedClusters}
                    loading={clustersQuery.loading}
                    loadError={clustersQuery.error?.message ?? ''}
                    onRetry={() => void clustersQuery.reload()}
                    region={region}
                    selectedIds={draft.clusterIds}
                    onSelectionChange={(clusterIds) => update({ clusterIds }, ['clusters'])}
                    showAll={draft.showAllClusters}
                    onShowAllChange={(showAllClusters) => update({ showAllClusters })}
                    error={errors.clusters}
                  />
                </>
              )}

              {step === 'values' && (
                <>
                  <Banner tone="warn" title="Keep secrets out of values">
                    Do not include passwords, tokens, certificates, or other secret material.
                    Reference existing Kubernetes or external secrets from the chart values. Values
                    overrides are not saved in drafts, so secrets never touch browser storage.
                  </Banner>
                  <ValuesEditor
                    id={fieldControlIds.values}
                    label={`${region} values override`}
                    value={override}
                    error={errors.values}
                    placeholder={`# Keys here override the chart defaults in ${region}\nreplicaCount: 3\n`}
                    onChange={(value) =>
                      update({ regionValues: { ...draft.regionValues, [region]: value } }, [
                        'values',
                      ])
                    }
                  />
                  <details className="chart-defaults">
                    <summary>
                      Chart defaults
                      {defaults && (
                        <span className="mono subtle">
                          {' '}
                          {defaults.chartName}@{defaults.chartRevision}
                        </span>
                      )}
                    </summary>
                    {valuesYaml ? (
                      <pre className="chart-defaults-code">{valuesYaml}</pre>
                    ) : (
                      <p className="wizard-placeholder">The chart defaults have not loaded.</p>
                    )}
                  </details>
                </>
              )}

              {step === 'review' && (
                <>
                  <ReviewSection title="Application" onEdit={() => goTo('application')}>
                    <KeyValueList
                      items={[
                        { label: 'Name', value: name, mono: true },
                        { label: 'Scope', value: scope, mono: true },
                        {
                          label: 'Chart',
                          value: defaults ? `${defaults.chartName}@${defaults.chartRevision}` : '',
                          mono: true,
                        },
                      ]}
                    />
                  </ReviewSection>
                  <ReviewSection
                    title={`Targets · ${selectedClusters.length}`}
                    onEdit={() => goTo('targets')}
                  >
                    <ul className="review-targets">
                      {selectedClusters.map((cluster) => (
                        <li key={cluster.id}>
                          <ProviderLogo provider={cluster.provider} />
                          <strong>{cluster.name}</strong>
                          <span className="mono subtle">{cluster.location || 'Unknown'}</span>
                        </li>
                      ))}
                    </ul>
                  </ReviewSection>
                  <ReviewSection title="Values" onEdit={() => goTo('values')}>
                    <p>
                      Chart defaults
                      {overrideCount > 0
                        ? ` + ${plural(overrideCount, 'region override')} (${region})`
                        : ' only'}
                    </p>
                  </ReviewSection>
                  <ReviewSection title="Resources">
                    {resourcePlan ? (
                      <ResourcePlanTable resources={resourcePlan} />
                    ) : (
                      <p className="wizard-placeholder">
                        {valuesYaml
                          ? 'Enter a valid application name to preview the generated resources.'
                          : 'The chart defaults are unavailable, so the resources cannot be planned and onboarding is disabled.'}
                      </p>
                    )}
                  </ReviewSection>
                </>
              )}
            </div>

            <footer className="wizard-panel-footer">
              {currentIndex > 0 ? (
                <Button icon={<ChevronLeftIcon />} onClick={back} disabled={submitting}>
                  Back
                </Button>
              ) : (
                <span />
              )}
              {step === 'review' ? (
                <Button
                  variant="primary"
                  type="submit"
                  icon={<DeployIcon />}
                  loading={submitting}
                  disabled={clustersQuery.loading || !valuesYaml}
                >
                  {submitting ? 'Onboarding…' : 'Onboard'}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  type="submit"
                  aria-describedby={
                    step === 'targets' && errors.clusters ? targetsErrorId : undefined
                  }
                >
                  Next
                  <ChevronRightIcon aria-hidden="true" />
                </Button>
              )}
            </footer>
          </form>

          {step !== 'review' && (
            <PlanPreview
              resources={resourcePlan}
              scope={scope}
              targetCount={draft.clusterIds.length}
              waitingForDefaults={!valuesYaml}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function ReviewSection({
  title,
  onEdit,
  children,
}: {
  title: string
  onEdit?: () => void
  children: ReactNode
}) {
  return (
    <section className="review-section" aria-label={title}>
      <header className="review-section-header">
        <h3>{title}</h3>
        {onEdit && (
          <button type="button" className="link-button" onClick={onEdit}>
            Edit<span className="sr-only"> {title.split(' ·')[0].toLowerCase()}</span>
          </button>
        )}
      </header>
      {children}
    </section>
  )
}
