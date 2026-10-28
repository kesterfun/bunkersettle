import { useChain } from "../chain/ChainContext";
import "./Toasts.css";

/** Transaction toasts: pending, confirmed, or the decoded custom error (name + args). */
export function Toasts() {
  const { toasts, dismissToast } = useChain();
  return (
    <div className="ts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`ts-item ts-${t.kind}`}>
          <div className="ts-head">
            <b>{t.title}</b>
            <button type="button" className="ts-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </div>
          {t.detail && <p>{t.detail}</p>}
          {t.error && (
            <p className="ts-err">
              <span className="mono">
                {t.error.name}
                {t.error.args ? `(${t.error.args})` : ""}
              </span>
              {t.error.message && <span className="ts-msg">{t.error.message}</span>}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
