import { parse, YAMLParseError } from 'yaml'
import type { Cluster } from '../../api/inventory'
import type { OnboardingDefaults } from '../../api/onboarding'
import { dnsLabel } from './onboarding-plan'

/**
 * The wizard's rules, kept out of the components: which step owns which
 * field, what makes a step complete, how a draft survives a reload, and where
 * a server rejection belongs.
 */

export const wizardSteps = [
  {
    id: 'application',
    label: 'Application',
    title: 'Name the application',
    description:
      'The name becomes the namespace, the Argo CD application, and the values repository.',
  },
  {
    id: 'scope',
    label: 'Scope',
    title: 'Choose where it belongs',
    description: 'Environment and region are part of the release identity.',
  },
  {
    id: 'targets',
    label: 'Targets',
    title: 'Pick target clusters',
    description: 'The clusters this release deploys to through their Argo CD.',
  },
  {
    id: 'values',
    label: 'Values',
    title: 'Adjust values',
    description: 'The chart defaults are used as-is; the region can override individual keys.',
  },
  {
    id: 'review',
    label: 'Review',
    title: 'Review and onboard',
    description: 'Onboarding commits values to GitHub and creates the Argo CD application.',
  },
] as const

export type StepId = (typeof wizardSteps)[number]['id']
export type FieldId = 'name' | 'environment' | 'region' | 'clusters' | 'values'
export type FieldErrors = Partial<Record<FieldId, string>>

export const fieldSteps: Record<FieldId, StepId> = {
  name: 'application',
  environment: 'scope',
  region: 'scope',
  clusters: 'targets',
  values: 'values',
}

// The backend's own validation lists; used only if an older API omits them.
export const fallbackEnvironments = ['dev', 'qa', 'prod']
export const fallbackRegions = ['us-east-1', 'us-east-2']

export function scopeChoices(defaults: OnboardingDefaults | undefined) {
  return {
    environments: defaults?.environments?.length ? defaults.environments : fallbackEnvironments,
    regions: defaults?.regions?.length ? defaults.regions : fallbackRegions,
  }
}

export type WizardDraft = {
  name: string
  environment: string
  region: string
  clusterIds: string[]
  regionValues: Record<string, string>
  showAllClusters: boolean
  step: StepId
}

export function emptyDraft(environment = 'dev', region = 'us-east-1'): WizardDraft {
  return {
    name: '',
    environment,
    region,
    clusterIds: [],
    regionValues: {},
    showAllClusters: false,
    step: 'application',
  }
}

/* Validation -------------------------------------------------------------- */

const maxValuesBytes = 256 * 1024

export function deploymentScope(environment: string, region: string) {
  return `${environment}-${region}`
}

/** Room left for the name once `-{environment}-{region}` is appended. */
export function maxNameLength(environment: string, region: string) {
  return 63 - deploymentScope(environment, region).length - 1
}

export function nameError(name: string, environment: string, region: string) {
  if (!name) return 'Enter an application name.'
  if (name.length > maxNameLength(environment, region)) {
    return `Application name must leave room for the ${deploymentScope(environment, region)} deployment suffix.`
  }
  if (!dnsLabel.test(name)) {
    return 'Use lowercase letters, digits, and hyphens, starting and ending with a letter or digit.'
  }
  return ''
}

export type MappingCheck = { error: string; line?: number; keys?: number }

/** Parses an override the way the backend will, so a bad file never leaves the browser. */
export function checkMapping(yamlText: string, label: string): MappingCheck {
  if (new TextEncoder().encode(yamlText).length > maxValuesBytes) {
    return { error: `${label} must not exceed 256 KiB.` }
  }
  try {
    const values: unknown = parse(yamlText)
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return { error: `${label} must contain a top-level YAML mapping.` }
    }
    return { error: '', keys: Object.keys(values).length }
  } catch (error) {
    const line = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined
    return {
      error: `${label} contains invalid YAML${line ? ` on line ${line}` : ''}.`,
      line,
    }
  }
}

export function overrideError(draft: WizardDraft) {
  const override = draft.regionValues[draft.region]
  if (!override?.trim()) return ''
  return checkMapping(override, `${draft.region} values`).error
}

/** Every problem a step has, keyed by the field that should show it. */
export function validateStep(step: StepId, draft: WizardDraft): FieldErrors {
  const errors: FieldErrors = {}
  switch (step) {
    case 'application': {
      const message = nameError(draft.name, draft.environment, draft.region)
      if (message) errors.name = message
      break
    }
    case 'scope':
      // A longer scope can push an accepted name over the DNS limit.
      if (draft.name && draft.name.length > maxNameLength(draft.environment, draft.region)) {
        errors.environment = `This scope leaves room for ${maxNameLength(draft.environment, draft.region)} characters; shorten the application name or pick a shorter scope.`
      }
      break
    case 'targets':
      if (draft.clusterIds.length === 0) errors.clusters = 'Select at least one target cluster.'
      break
    case 'values': {
      const message = overrideError(draft)
      if (message) errors.values = message
      break
    }
    case 'review':
      break
  }
  return errors
}

export function stepIndex(step: StepId) {
  return wizardSteps.findIndex((item) => item.id === step)
}

/** The first step with a problem, so submit and draft restore land somewhere fixable. */
export function firstInvalidStep(draft: WizardDraft): StepId | null {
  for (const step of wizardSteps) {
    if (Object.keys(validateStep(step.id, draft)).length > 0) return step.id
  }
  return null
}

/* Targets ----------------------------------------------------------------- */

/** Zonal locations (us-east-1a) belong to their region. */
export function clusterInRegion(cluster: Pick<Cluster, 'location'>, region: string) {
  return cluster.location === region || cluster.location.startsWith(region)
}

export function matchesSearch(cluster: Cluster, search: string) {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return [cluster.name, cluster.sourceName, cluster.location, cluster.provider].some((value) =>
    value.toLowerCase().includes(needle),
  )
}

/* Draft persistence -------------------------------------------------------- */

export const draftStorageKey = 'kubeops.onboarding.draft'

function isStep(value: unknown): value is StepId {
  return wizardSteps.some((step) => step.id === value)
}

/**
 * A draft from this tab's session, or null. Storage can be missing or hold
 * junk. Values overrides are never read back, even from a draft an older
 * build stored: they are not persisted (see saveDraft).
 */
export function loadDraft(): WizardDraft | null {
  try {
    const raw = window.sessionStorage.getItem(draftStorageKey)
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<WizardDraft>
    const draft: WizardDraft = {
      ...emptyDraft(),
      name: typeof stored.name === 'string' ? stored.name : '',
      clusterIds: Array.isArray(stored.clusterIds)
        ? stored.clusterIds.filter((id): id is string => typeof id === 'string')
        : [],
      showAllClusters: stored.showAllClusters === true,
      step: isStep(stored.step) ? stored.step : 'application',
    }
    if (typeof stored.environment === 'string') draft.environment = stored.environment
    if (typeof stored.region === 'string') draft.region = stored.region
    return draft
  } catch {
    return null
  }
}

export function hasDraftContent(draft: WizardDraft) {
  return (
    draft.name !== '' ||
    draft.clusterIds.length > 0 ||
    Object.values(draft.regionValues).some((value) => value.trim())
  )
}

/**
 * Keeps the draft for the rest of the tab's session, minus its values
 * overrides: operators paste secrets into values despite the warning, and
 * browser storage is readable by any script on the origin.
 */
export function saveDraft(draft: WizardDraft) {
  const persisted: WizardDraft = { ...draft, regionValues: {} }
  try {
    if (hasDraftContent(persisted)) {
      window.sessionStorage.setItem(draftStorageKey, JSON.stringify(persisted))
    } else {
      window.sessionStorage.removeItem(draftStorageKey)
    }
  } catch {
    // A draft that cannot be kept only costs a retype after a reload.
  }
}

export function clearDraft() {
  try {
    window.sessionStorage.removeItem(draftStorageKey)
  } catch {
    // Nothing was stored.
  }
}

/* Server errors ------------------------------------------------------------ */

const serverErrorFields: [RegExp, FieldId][] = [
  [/^(application )?name\b|already onboarded/i, 'name'],
  [/^namespace\b/i, 'name'],
  [/^environment\b/i, 'environment'],
  [/^region must\b/i, 'region'],
  [/target cluster|removed clusters|^cluster "|Argo CD target/i, 'clusters'],
  [/^region names\b|^[a-z0-9-]+ values must/i, 'values'],
]

/**
 * Which field a 409/422 message is about, when it is recognisably one of the
 * backend's validation messages. Anything else stays a form-level error.
 */
export function serverErrorField(status: number, message: string): FieldId | null {
  if (status !== 409 && status !== 422) return null
  for (const [pattern, field] of serverErrorFields) {
    if (pattern.test(message)) return field
  }
  return null
}
