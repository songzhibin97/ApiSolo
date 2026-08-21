import type { CollectionNode } from "../types"

export interface CollectionOption {
  label: string
  value: string
}

/**
 * Every folder in the tree, nested ones spelled out with their parents. Shared
 * by both save dialogs on purpose: two copies of this walk would drift, and a
 * dialog that offers fewer destinations than the other is a silent restriction
 * on where a request can go.
 */
export function flattenCollectionFolders(nodes: CollectionNode[]): CollectionOption[] {
  return nodes.flatMap((node) => {
    if (node.nodeType !== "folder") {
      return []
    }

    return [
      { label: node.name, value: node.path },
      ...flattenCollectionFolders(node.children).map((child) => ({
        label: `${node.name} / ${child.label}`,
        value: child.value,
      })),
    ]
  })
}
