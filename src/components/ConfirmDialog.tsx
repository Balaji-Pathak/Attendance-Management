import React, { useState } from 'react';
import { AlertTriangle, FileSpreadsheet, X } from 'lucide-react';
import { ConfirmRequest } from '../types/attendance';

interface ConfirmDialogProps {
  request: ConfirmRequest | null;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ request, onClose }) => {
  const [submitting, setSubmitting] = useState(false);

  if (!request) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await request.onConfirm();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                request.destructive
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : 'border-teal-200 bg-teal-50 text-teal-700'
              }`}
            >
              {request.destructive ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <FileSpreadsheet className="h-4 w-4" />
              )}
            </div>
            <h2
              id="confirm-dialog-title"
              className="text-base font-semibold text-slate-900"
            >
              {request.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-teal-700"
            aria-label="Close confirmation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <p className="text-sm leading-relaxed text-slate-600">{request.description}</p>

          {request.affectedTarget && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-xs font-medium text-slate-500">Target Google Sheet</div>
              <div className="mt-0.5 text-sm font-medium text-slate-900 break-all">
                {request.affectedTarget}
              </div>
            </div>
          )}

          {request.details && request.details.length > 0 && (
            <ul className="space-y-1.5 border-t border-slate-100 pt-3 text-xs text-slate-600">
              {request.details.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="mt-0.5 font-mono text-slate-400">–</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-200 bg-slate-50/60 px-6 py-4 rounded-b-xl">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap shrink-0 ${
              request.destructive
                ? 'bg-red-700 hover:bg-red-800 disabled:bg-red-400'
                : 'bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400'
            }`}
          >
            {submitting ? 'Processing...' : request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
