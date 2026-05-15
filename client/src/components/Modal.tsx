import { useEffect, useRef, type ReactNode } from "react";
import "./Modal.css";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: string;
  disableBackdropDismiss?: boolean;
  hideClose?: boolean;
}

export default function Modal({ open, onClose, children, className, width, disableBackdropDismiss, hideClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      dialog.showModal();
      document.body.style.overflow = "hidden";
    } else {
      dialog.close();
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current && !disableBackdropDismiss) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`modal${className ? ` ${className}` : ""}`}
      style={width ? { width } : undefined}
      onClick={handleBackdropClick}
    >
      {!hideClose && (
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="3" x2="13" y2="13" />
            <line x1="13" y1="3" x2="3" y2="13" />
          </svg>
        </button>
      )}
      {children}
    </dialog>
  );
}
