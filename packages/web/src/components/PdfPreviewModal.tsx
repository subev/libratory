import { Modal, ModalHeader } from "./Modal.tsx";

export function PdfPreviewModal({
  fileId,
  page,
  filename,
  onClose,
}: {
  fileId: string;
  page?: number;
  filename?: string;
  onClose: () => void;
}) {
  return (
    <Modal size="full" onClose={onClose} backdropTestId="pdf-preview-modal">
      <ModalHeader
        title={<>{filename}{page ? <span className="text-(--text-muted)"> — page {page}</span> : null}</>}
        onClose={onClose}
      />
      {/* Keyed by page so the browser's PDF viewer re-navigates — hash-only changes are ignored. */}
      <iframe
        key={`${fileId}-${page ?? 0}`}
        src={`/pdf/${fileId}${page ? `#page=${page}` : ""}`}
        className="flex-1 w-full"
        title="PDF Preview"
      />
    </Modal>
  );
}
