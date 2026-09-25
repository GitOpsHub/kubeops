import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { syncApplication, type SyncOptions } from '../../api/argo'
import { ApiError, errorMessage, isAbortError } from '../../api/client'
import {
  getTargetResources,
  offboardApplicationOnboarding,
  scaleApplicationOnboarding,
  type ApplicationOnboarding,
} from '../../api/onboarding'
import { useToast } from '../../components/ui/toast-context'
import { usePolledResource } from '../../hooks/usePolledResource'
import type { AppShellContext } from '../../lib/app-shell'
import {
  endpointLinks,
  getApplicationReleases,
  releaseScope,
  type ApplicationEndpoint,
} from './application-detail'
import type { DetailAction } from './DetailHeader'

const pollIntervalMs = 5_000

/**
 * Everything the detail page does, apart from drawing it: the polled release
 * set, the endpoints read off each target, and the sync, scale, and offboard
 * requests with the toasts that report them.
 */
export function useApplicationDetail(id: string) {
  const navigate = useNavigate()
  const { setApplicationTopbar } = useOutletContext<AppShellContext>()
  const [action, setAction] = useState<DetailAction>(null)
  // Action outcomes are toasts: they report something that just happened and
  // should not push the page down or linger as stale state.
  const toast = useToast()
  const [scaling, setScaling] = useState(false)
  const [scaleError, setScaleError] = useState('')
  const [confirmingOffboard, setConfirmingOffboard] = useState(false)
  const [endpoints, setEndpoints] = useState<ApplicationEndpoint[]>([])

  const load = useCallback((signal: AbortSignal) => getApplicationReleases(id, signal), [id])
  const releasesQuery = usePolledResource(load, { intervalMs: pollIntervalMs })
  const releases = releasesQuery.data ?? []
  const missing = releasesQuery.error instanceof ApiError && releasesQuery.error.status === 404
  const record = releases.find((release) => release.id === id) ?? null

  const { mutate } = releasesQuery
  const replaceRelease = useCallback(
    (next: ApplicationOnboarding) =>
      mutate((current) => current?.map((release) => (release.id === next.id ? next : release))),
    [mutate],
  )

  // The breadcrumb shows the name instead of the ID.
  const recordName = record?.name
  useEffect(() => {
    setApplicationTopbar(recordName ? { name: recordName } : null)
  }, [recordName, setApplicationTopbar])
  useEffect(() => () => setApplicationTopbar(null), [setApplicationTopbar])

  // Endpoints come from the live Services and Ingresses on each target. Keyed
  // on the target set rather than the record, so a poll that changes only a
  // status does not refetch every target's resource tree.
  const recordId = record?.id
  const targetIds = record?.targets.map((target) => target.id).join(',') ?? ''
  useEffect(() => {
    setEndpoints([])
    if (!recordId || !targetIds) return
    const controller = new AbortController()
    void Promise.all(
      targetIds
        .split(',')
        .map((targetId) => getTargetResources(recordId, targetId, controller.signal)),
    )
      .then((resources) => {
        if (!controller.signal.aborted) setEndpoints(endpointLinks(resources.flat()))
      })
      .catch((error) => {
        if (!isAbortError(error)) setEndpoints([])
      })
    return () => controller.abort()
  }, [recordId, targetIds])

  /** Resolves true once Argo CD accepted the request, so callers can follow it. */
  async function sync(options: SyncOptions) {
    if (!record) return false
    setAction('sync')
    const chosen = options.targetIds?.length
      ? record.targets.filter((target) => options.targetIds?.includes(target.id))
      : record.targets
    const names = chosen.map((target) => target.clusterName).join(', ')
    const everyTarget = chosen.length === record.targets.length
    try {
      const next = await syncApplication(record.id, options)
      if (options.dryRun) {
        // A dry run changes nothing, so the record it returns is unchanged
        // and the outcome only shows up in each target's operation.
        toast.info(`Dry run started on ${names}.`, {
          description: 'Its results appear in the Sync tab once Argo CD finishes.',
        })
        return true
      }
      replaceRelease(next)
      const failed = next.targets.some(
        (target) => target.status === 'failed' && chosen.some((picked) => picked.id === target.id),
      )
      if (failed) {
        toast.error('Synchronization could not start for one or more deployment targets.')
      } else if (everyTarget) {
        toast.success('Synchronization started for every deployment target.')
      } else {
        toast.success(`Synchronization started for ${names}.`)
      }
      return !failed
    } catch (error) {
      toast.error(errorMessage(error, 'Synchronization could not be started.'))
      return false
    } finally {
      setAction(null)
    }
  }

  async function scale(replicas: number) {
    if (!record) return false
    setAction('scale')
    setScaleError('')
    try {
      const next = await scaleApplicationOnboarding(record.id, replicas)
      replaceRelease(next)
      setScaling(false)
      if (next.targets.some((target) => target.status === 'failed')) {
        toast.error(
          `The ${replicas}-pod value was committed, but synchronization failed for one or more clusters.`,
        )
      } else {
        toast.success(
          `Scaling ${releaseScope(next)} to ${replicas} ${replicas === 1 ? 'pod' : 'pods'} through GitOps.`,
        )
      }
      return true
    } catch (error) {
      setScaleError(errorMessage(error, 'The application could not be scaled.'))
      return false
    } finally {
      setAction(null)
    }
  }

  async function offboard() {
    if (!record) return
    setAction('offboard')
    try {
      const next = await offboardApplicationOnboarding(record.id)
      setConfirmingOffboard(false)
      if (next.status === 'offboarded') {
        // Nothing is left to operate on here, so the view moves on: to a
        // sibling release if there is one, otherwise back to the list.
        const remaining = releases.filter((release) => release.id !== next.id)
        mutate(() => remaining)
        toast.success(`${next.name} was offboarded. Its GitHub values were kept.`)
        navigate(remaining.length > 0 ? `/applications/${remaining[0].id}` : '/applications', {
          replace: true,
        })
        return
      }
      replaceRelease(next)
      toast.error('One or more clusters could not be offboarded. GitHub values were kept.')
    } catch (error) {
      toast.error(errorMessage(error, 'Application could not be offboarded.'))
    } finally {
      setAction(null)
    }
  }

  function selectRelease(releaseId: string) {
    setConfirmingOffboard(false)
    setScaling(false)
    navigate(`/applications/${releaseId}`, { replace: true })
  }

  return {
    releasesQuery,
    releases,
    record,
    missing,
    endpoints,
    action,
    replaceRelease,
    sync,
    scale,
    offboard,
    selectRelease,
    scaling,
    setScaling,
    scaleError,
    setScaleError,
    confirmingOffboard,
    setConfirmingOffboard,
  }
}
