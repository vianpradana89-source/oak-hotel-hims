import type { RoomOperationalBlock } from './calendarTypes';

interface Props {
  block: RoomOperationalBlock;
  span: number;
  roomNumber: string;
  onOpen: (block: RoomOperationalBlock) => void;
}

export default function OperationalBlockBar(props: Props) {
  const { block, span, onOpen } = props;

  const getBlockStyle = () => {
    switch (block.block_type) {
      case 'OUT_OF_ORDER':
        return {
          cardClass: 'bg-rose-50/95 border-rose-300/80 text-rose-900 hover:bg-rose-100/90 shadow-2xs',
          badgeClass: 'bg-rose-200/80 text-rose-800 border-rose-300',
          badgeText: 'OOO'
        };
      case 'OUT_OF_SERVICE':
        return {
          cardClass: 'bg-slate-100/95 border-slate-300/80 text-slate-800 hover:bg-slate-200/90 shadow-2xs',
          badgeClass: 'bg-slate-200/80 text-slate-700 border-slate-300',
          badgeText: 'OOS'
        };
      case 'MAINTENANCE':
      default:
        return {
          cardClass: 'bg-amber-50/95 border-amber-300/80 text-amber-900 hover:bg-amber-100/90 shadow-2xs',
          badgeClass: 'bg-amber-200/80 text-amber-800 border-amber-300',
          badgeText: 'MAINTENANCE'
        };
    }
  };

  const style = getBlockStyle();

  return (
    <td colSpan={span} className="p-1 border align-middle h-14">
      <div
        onClick={() => onOpen(block)}
        className={`operational-block-card relative overflow-hidden rounded-md border px-2.5 py-1.5 cursor-pointer select-none transition-all duration-150 ${style.cardClass}`}
        title={`Operational Block (${style.badgeText}): ${block.reason || 'Blok Kamar Operasional'} [${block.start_date} s/d ${block.end_date}]`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${style.badgeClass}`}>
              {style.badgeText}
            </span>
            <span className="text-xs font-semibold truncate text-slate-800">
              {block.reason || 'Blok Operasional'}
            </span>
          </div>
          <span className="text-[10px] text-slate-500 font-medium shrink-0">
            {span} malam
          </span>
        </div>
        <div className="text-[10px] text-slate-500 font-normal mt-0.5 truncate flex items-center gap-1">
          <span>{block.start_date}</span>
          <span>→</span>
          <span>{block.end_date}</span>
          {block.created_by && (
            <span className="opacity-75">· oleh {block.created_by}</span>
          )}
        </div>
      </div>
    </td>
  );
}
