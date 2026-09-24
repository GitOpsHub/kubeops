import type { ApplicationOnboarding } from '../../api/onboarding'
import { valuesFileLink } from './application-detail'

export function ChartValuesPanel({ record }: { record: ApplicationOnboarding }) {
  const valuesFile = valuesFileLink(record)
  return (
    <dl className="fact-grid chart-facts">
      <div>
        <dt>Chart</dt>
        <dd className="mono">
          {record.chartName} {record.chartRevision}
        </dd>
      </div>
      <div>
        <dt>Chart repository</dt>
        <dd className="mono">{record.chartRepoUrl}</dd>
      </div>
      <div>
        <dt>Values file</dt>
        <dd>
          {valuesFile ? (
            <a
              href={valuesFile.url}
              target="_blank"
              rel="noreferrer"
              title={`Open ${valuesFile.path} at ${valuesFile.revision}`}
            >
              {record.valuesRepositoryName}/{valuesFile.path} ↗
            </a>
          ) : (
            '—'
          )}
        </dd>
      </div>
      <div>
        <dt>Values revision</dt>
        <dd className="mono">{record.valuesRevision || '—'}</dd>
      </div>
      <div>
        <dt>Values commit</dt>
        <dd className="mono">{record.valuesCommitSha || '—'}</dd>
      </div>
      <div>
        <dt>Values digest</dt>
        <dd className="mono">{record.valuesDigest}</dd>
      </div>
    </dl>
  )
}
