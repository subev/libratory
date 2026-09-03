import { Modal, ModalHeader } from "../Modal.tsx";
import { UploadZone } from "../UploadZone.tsx";

export function UploadModal({
  folderId,
  onUploaded,
  onClose,
}: {
  folderId: string | null;
  onUploaded: (ok: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal size="md" onClose={onClose} testId="upload-modal">
      <ModalHeader
        title="Add books"
        subtitle={folderId ? "Uploaded into this folder" : "Drop PDFs, or a folder to scan for them"}
        onClose={onClose}
      />
      <div className="p-4 overflow-y-auto">
        <UploadZone folderId={folderId} onUploadComplete={onUploaded} />
      </div>
    </Modal>
  );
}
