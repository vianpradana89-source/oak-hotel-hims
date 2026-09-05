import React from 'react';
import { ShiftTemplateManager } from './ShiftTemplateManager';

interface KelolaShiftDrawerProps {
  propertyId: number;
  onClose: () => void;
  onTemplatesUpdated: () => void;
}

export const KelolaShiftDrawer: React.FC<KelolaShiftDrawerProps> = ({ propertyId, onClose, onTemplatesUpdated }) => {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-xs" onClick={onClose} />
      <div className="relative w-[520px] bg-white h-full shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white z-10 px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-sm text-slate-900">Kelola Shift</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 cursor-pointer">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-4">
          <ShiftTemplateManager
            propertyId={propertyId}
            onTemplatesUpdated={() => {
              onTemplatesUpdated();
            }}
          />
        </div>
      </div>
    </div>
  );
};
