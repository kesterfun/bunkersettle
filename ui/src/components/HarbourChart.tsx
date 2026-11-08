import type { KeyboardEvent } from "react";
import { ANCHORAGES, STATUS_TONE, isBunkering, isFinanced, isMyTurn, type OrderView, type Tone } from "../domain";
import type { Me } from "../chain/ChainContext";

const MAX_PINS = 6;
const COLS = 3;
const TONES: Tone[] = ["progress", "action", "disputed", "done", "void"];

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

interface Props {
  orders: OrderView[];
  me: Me | null;
  selected: number | null;
  onSelect: (id: number) => void;
  onFilter: (anchorage: number) => void;
}

/** Harbour chart: land, traffic lanes, anchorage zones and one pin per order. */
export function HarbourChart({ orders, me, selected, onSelect, onFilter }: Props) {
  const attention = (o: OrderView) => STATUS_TONE[o.status] === "disputed" || isMyTurn(o, me);

  const layers = ANCHORAGES.map((a) => {
    const inZone = orders.filter((o) => o.anchorage === a.id).sort((x, y) => x.id - y.id);
    const cx = a.zone.x + a.zone.w / 2;
    const cy = a.zone.y + a.zone.h / 2;
    if (inZone.length > MAX_PINS) {
      const counts = TONES.map((t) => inZone.filter((o) => STATUS_TONE[o.status] === t).length);
      let acc = 0;
      const segs = TONES.map((t, i) => {
        const seg = { t, n: counts[i], off: -acc };
        acc += counts[i];
        return seg;
      }).filter((s) => s.n > 0);
      const hasSel = inZone.some((o) => o.id === selected);
      const cluster = (
        <g
          key={`c${a.id}`}
          className="hv-cluster"
          tabIndex={0}
          role="button"
          aria-label={`${a.name}, ${inZone.length} orders. Show only this anchorage`}
          onClick={() => onFilter(a.id)}
          onKeyDown={activate(() => onFilter(a.id))}
        >
          {hasSel && <circle className="hv-sel" cx={cx} cy={cy} r={22} />}
          <circle className="hv-cl-bg" cx={cx} cy={cy} r={18} />
          <g transform={`rotate(-90 ${cx} ${cy})`} fill="none" strokeWidth={6}>
            {segs.map((s) => (
              <circle
                key={s.t}
                className={`tone-${s.t} hv-seg`}
                cx={cx}
                cy={cy}
                r={16}
                pathLength={inZone.length}
                strokeDasharray={`${s.n} ${inZone.length - s.n}`}
                strokeDashoffset={s.off}
              />
            ))}
          </g>
          <text className="hv-cl-n" x={cx} y={cy + 5} textAnchor="middle">
            {inZone.length}
          </text>
        </g>
      );
      return { pins: [] as { o: OrderView; x: number; y: number }[], cluster };
    }
    const pins = inZone.map((o, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = a.zone.x + (a.zone.w * (2 * col + 1)) / (2 * COLS);
      const y = a.zone.y + a.zone.h * (row === 0 ? 0.27 : 0.73);
      return { o, x, y };
    });
    return { pins, cluster: null };
  });

  // Attention pins (disputed or my turn) are drawn last so they sit on top.
  const pinNodes = layers.flatMap((l) => l.pins).sort((p, q) => Number(attention(p.o)) - Number(attention(q.o)));

  return (
    <svg className="hv-svg" viewBox="0 0 600 340" role="group" aria-label="Chart of Singapore bunkering anchorages">
      <rect width="600" height="340" className="hv-water" />
      <polygon points="0,250 600,228 600,340 0,340" className="hv-deep" />
      <g className="hv-land">
        <polygon points="0,0 600,0 600,86 520,104 430,92 350,116 270,100 190,112 120,96 0,118" />
        <polygon points="40,134 128,128 150,156 96,170 46,160" />
        <polygon points="186,174 214,168 222,184 194,190" />
        <polygon points="300,132 352,128 358,142 306,146" />
      </g>
      <text x="330" y="52" textAnchor="middle" className="hv-sea">
        SINGAPORE
      </text>
      <g className="hv-place" textAnchor="middle">
        <text x="96" y="152">Jurong Island</text>
        <text x="204" y="204">Pulau Bukom</text>
        <text x="330" y="160">Sentosa</text>
      </g>
      <g className="hv-lane">
        <line x1="0" y1="282" x2="600" y2="262" />
        <line x1="0" y1="312" x2="600" y2="292" />
      </g>
      <text x="300" y="296" textAnchor="middle" className="hv-tss">
        Singapore Strait traffic separation scheme
      </text>
      <g className="hv-zones">
        {ANCHORAGES.map((a) => (
          <rect key={a.id} x={a.zone.x} y={a.zone.y} width={a.zone.w} height={a.zone.h} />
        ))}
      </g>
      <g className="hv-zlabel" textAnchor="middle">
        {ANCHORAGES.map((a) => (
          <text key={a.id} x={a.label.x} y={a.label.y}>
            {a.name}
          </text>
        ))}
      </g>
      <g className="hv-sounding">
        <text x="300" y="196">18</text>
        <text x="160" y="276">23</text>
        <text x="440" y="250">27</text>
        <text x="20" y="246">14</text>
        <text x="560" y="152">16</text>
        <text x="300" y="232">21</text>
      </g>
      <g transform="translate(560,40)" className="hv-north">
        <polygon points="0,-18 6,4 0,0 -6,4" />
        <text y="18" textAnchor="middle">N</text>
      </g>

      {layers.map((l) => l.cluster)}

      {pinNodes.map(({ o, x, y }) => {
        const tone = STATUS_TONE[o.status];
        return (
          <g
            key={o.id}
            className={`hv-pin tone-${tone}`}
            tabIndex={0}
            role="button"
            aria-label={`Order ${o.id}, ${o.status}`}
            aria-pressed={o.id === selected}
            onClick={() => onSelect(o.id)}
            onKeyDown={activate(() => onSelect(o.id))}
          >
            {o.id === selected && <circle className="hv-sel" cx={x} cy={y} r={12.5} />}
            <circle className="hv-dot" cx={x} cy={y} r={9} />
            <text className="hv-pin-n" x={x} y={y + 3.5} textAnchor="middle">
              {o.id}
            </text>
            {isFinanced(o) && (
              <g className="hv-fin">
                <title>Financed: the payment claim is held by a financier</title>
                <circle cx={x - 9} cy={y + 9} r={4.5} />
                <text x={x - 9} y={y + 11.8} textAnchor="middle">$</text>
              </g>
            )}
            {isBunkering(o) && (
              <g className="hv-bravo">
                <line x1={x + 10} y1={y - 12} x2={x + 10} y2={y + 2} />
                <polygon points={`${x + 10},${y - 12} ${x + 22},${y - 12} ${x + 18},${y - 8} ${x + 22},${y - 4} ${x + 10},${y - 4}`} />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
