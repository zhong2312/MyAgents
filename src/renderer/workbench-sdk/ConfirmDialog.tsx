import HostConfirmDialog from "@/components/ConfirmDialog";

export interface ConfirmDialogProps {
  readonly title: string;
  readonly message: string;
  readonly confirmText?: string;
  readonly cancelText?: string;
  readonly confirmVariant?: "danger" | "primary";
  readonly loading?: boolean;
  readonly disableEnterShortcut?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Stable workbench boundary for the host-owned confirmation dialog. */
export default function ConfirmDialog(props: ConfirmDialogProps) {
  return <HostConfirmDialog {...props} />;
}
