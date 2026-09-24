import type { ResourceNode, ResourceRef } from '../../api/onboarding'

/** The tuple Argo CD addresses a resource by, taken off a tree node. */
export function toRef(node: ResourceNode): ResourceRef {
  return {
    group: node.group,
    version: node.version,
    kind: node.kind,
    namespace: node.namespace,
    name: node.name,
  }
}
