import type { ActivityBarItem } from './activity-bar-buttons'

type RightSidebarActivityVisibilityState = {
  isFolder: boolean
  isFolderWorkspace: boolean
  isSshRepo: boolean
  isStationRepo: boolean
}

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  { isFolder, isFolderWorkspace, isSshRepo, isStationRepo }: RightSidebarActivityVisibilityState
): ActivityBarItem[] {
  return items.filter((item) => {
    if (isStationRepo && (item.id === 'explorer' || item.id === 'ports')) {
      return false
    }
    if (item.gitOnly && isFolder) {
      return false
    }
    if (item.folderOnly && !isFolderWorkspace) {
      return false
    }
    if (item.sshOnly && !isSshRepo) {
      return false
    }
    return true
  })
}
