export interface TrendSparklineProps {
  data: number[];
  previousValue?: number | null;
  trendDelta?: number | null;
}

const NEUTRAL_LINE = '#5a6e7c';
const NEUTRAL_FILL = 'rgba(90,110,124,0.10)';
const NEUTRAL_DOT = '#5a6e7c';

function buildPath(data: number[], w: number, h: number): string {
  if (data.length === 0) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `M ${pts[0]} L ${pts.slice(1).join(' L ')}`;
}

function buildFillPath(data: number[], w: number, h: number): string {
  if (data.length < 2) return '';
  const line = buildPath(data, w, h);
  return `${line} L ${w},${h} L 0,${h} Z`;
}

export function TrendSparkline({ data, previousValue, trendDelta }: TrendSparklineProps) {
  if (!data || data.length === 0) return null;

  const W = 80;
  const H = 28;
  const last = data[data.length - 1];
  // Only show comparison when a real previous business date value is provided
  const hasRealPrevious = previousValue != null && data.length >= 2;

  // Build neutral comparison label only when we have a real previous value
  let comparisonLabel = '';
  if (hasRealPrevious && trendDelta != null) {
    if (trendDelta > 0) comparisonLabel = `↑ ${trendDelta} vs hari sebelumnya`;
    else if (trendDelta < 0) comparisonLabel = `↓ ${Math.abs(trendDelta)} vs hari sebelumnya`;
    else comparisonLabel = '— Sama seperti hari sebelumnya';
  }

  const pathD = buildPath(data, W, H);
  const fillD = buildFillPath(data, W, H);
  const lastX = W;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const lastY = H - ((last - min) / range) * H;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        aria-hidden="true"
        style={{ display: 'block', flexShrink: 0 }}
      >
        {data.length >= 2 && (
          <path d={fillD} fill={NEUTRAL_FILL} stroke="none" />
        )}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke={NEUTRAL_LINE}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        <circle cx={lastX} cy={lastY} r="2" fill={NEUTRAL_DOT} />
      </svg>
      {comparisonLabel && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: NEUTRAL_LINE,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
          }}
        >
          {comparisonLabel}
        </span>
      )}
    </div>
  );
}
