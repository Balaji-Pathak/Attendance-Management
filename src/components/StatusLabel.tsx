import React from 'react';
import { AlertTriangle, CheckCircle2, Clock, Minus } from 'lucide-react';
import { AttendanceStatus } from '../types/attendance';
import { getStatusLabel } from '../utils/time';

interface StatusLabelProps {
  status: AttendanceStatus | 'not_in';
}

export const StatusLabel: React.FC<StatusLabelProps> = ({ status }) => {
  if (status === 'on_duty') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap">
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{getStatusLabel(status)}</span>
      </span>
    );
  }

  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-800 whitespace-nowrap">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{getStatusLabel(status)}</span>
      </span>
    );
  }

  if (status === 'short_shift') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{getStatusLabel(status)}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
      <Minus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{getStatusLabel(status)}</span>
    </span>
  );
};
