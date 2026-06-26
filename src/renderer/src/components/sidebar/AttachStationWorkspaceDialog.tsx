import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plug } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMountedRef } from '@/hooks/useMountedRef'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { attachStationWorkspaceToStore } from '@/station/station-workspace-attach'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

const AttachStationWorkspaceDialog = React.memo(function AttachStationWorkspaceDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)

  const [workspaceIdInput, setWorkspaceIdInput] = useState('')
  const [isAttaching, setIsAttaching] = useState(false)
  const mountedRef = useMountedRef()
  const attachGenRef = useRef(0)

  const isOpen = activeModal === 'attach-station-workspace'
  const initialWorkspaceId = useMemo(
    () => (typeof modalData.workspaceId === 'string' ? modalData.workspaceId : ''),
    [modalData.workspaceId]
  )

  useEffect(() => {
    if (isOpen) {
      setWorkspaceIdInput(initialWorkspaceId)
      return
    }
    attachGenRef.current += 1
    setWorkspaceIdInput('')
    setIsAttaching(false)
  }, [initialWorkspaceId, isOpen])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        attachGenRef.current += 1
        closeModal()
      }
    },
    [closeModal]
  )

  const handleSubmit = useCallback(async () => {
    const workspaceId = workspaceIdInput.trim()
    if (!workspaceId || isAttaching) {
      return
    }

    const gen = ++attachGenRef.current
    setIsAttaching(true)
    try {
      const result = await attachStationWorkspaceToStore({
        workspaceId,
        activate: true,
        openInitialTerminal: true,
        persist: true
      })

      if (!mountedRef.current || gen !== attachGenRef.current) {
        return
      }

      closeModal()
      if (result.openedTabId) {
        focusTerminalTabSurface(result.openedTabId)
      }
    } catch (error) {
      if (!mountedRef.current || gen !== attachGenRef.current) {
        return
      }
      toast.error(
        translate(
          'auto.components.sidebar.AttachStationWorkspaceDialog.errorTitle',
          'Failed to attach Station workspace'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      if (mountedRef.current && gen === attachGenRef.current) {
        setIsAttaching(false)
      }
    }
  }, [closeModal, isAttaching, mountedRef, workspaceIdInput])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.sidebar.AttachStationWorkspaceDialog.title',
              'Attach Station Workspace'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.AttachStationWorkspaceDialog.description',
              'Enter a Station workspace ID to attach it as an Orca workspace.'
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <Input
            value={workspaceIdInput}
            onChange={(event) => setWorkspaceIdInput(event.target.value)}
            placeholder={translate(
              'auto.components.sidebar.AttachStationWorkspaceDialog.placeholder',
              'Workspace ID'
            )}
            autoFocus
            className="mb-4"
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
              {translate(
                'auto.components.sidebar.AttachStationWorkspaceDialog.cancel',
                'Cancel'
              )}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!workspaceIdInput.trim() || isAttaching}
            >
              {isAttaching ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
              {translate(
                'auto.components.sidebar.AttachStationWorkspaceDialog.confirm',
                'Attach Workspace'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})

export default AttachStationWorkspaceDialog
