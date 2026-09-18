import type { SimResult } from '../engine/simulate';

const fmt = (n: number) =>
  n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 1 : 0);

export function Results({ result }: { result: SimResult }) {
  const parts = [
    { label: 'Weapon', value: result.weaponDps, cls: 'bar-weapon' },
    { label: 'Damage over time', value: result.dotDps, cls: 'bar-dot' },
    { label: 'Ability', value: result.abilityDps, cls: 'bar-ability' },
  ].filter((p) => p.value > 0);

  return (
    <>
      <section className="results">
        <h2>Output</h2>
        <div className="headline">
          <span className="dps">{fmt(result.totalDps)}</span>
          <span className="unit">damage / second</span>
        </div>

        <div className="stacked-bar">
          {parts.map((p) => (
            <div
              key={p.label}
              className={p.cls}
              style={{ width: `${(100 * p.value) / result.totalDps}%` }}
              title={`${p.label}: ${fmt(p.value)} dps`}
            />
          ))}
        </div>
        <ul className="legend">
          {parts.map((p) => (
            <li key={p.label}>
              <i className={p.cls} /> {p.label}: {fmt(p.value)}
            </li>
          ))}
        </ul>

        <table className="stats">
          <tbody>
            <tr>
              <th>Per hit (blended)</th>
              <td>{fmt(result.perHit)}</td>
            </tr>
            <tr>
              <th>Per shot</th>
              <td>{fmt(result.perShot)}</td>
            </tr>
            <tr>
              <th>Per magazine</th>
              <td>{fmt(result.perMagazine)}</td>
            </tr>
            <tr>
              <th>Fire rate</th>
              <td>{result.stats.fireRate.toFixed(1)} /s{result.usesEstimates && ' *'}</td>
            </tr>
            <tr>
              <th>Clip / reload</th>
              <td>
                {result.stats.clipSize ?? '—'} / {result.stats.reloadTime.toFixed(1)}s
                {result.usesEstimates && ' *'}
              </td>
            </tr>
            <tr>
              <th>Damage multiplier</th>
              <td>&times;{result.stats.damageMultiplier.toFixed(3)}</td>
            </tr>
            <tr>
              <th>Weakspot multiplier</th>
              <td>&times;{result.stats.weakspotMultiplier.toFixed(3)}</td>
            </tr>
          </tbody>
        </table>
        {result.usesEstimates && (
          <p className="footnote">* estimated &mdash; the wiki publishes no rate-of-fire data.</p>
        )}
      </section>

      {result.breakdown.length > 0 && (
        <section>
          <h2>Contributions</h2>
          <table className="breakdown">
            <tbody>
              {result.breakdown.map((b, i) => (
                <tr key={i}>
                  <td>{b.source}</td>
                  <td className="stat">
                    {b.stat}
                    {b.scope !== 'all' && b.scope !== 'flat' && <em> ({b.scope})</em>}
                  </td>
                  <td className={b.value >= 0 ? 'pos' : 'neg'}>
                    {b.scope === 'flat'
                      ? `${b.value >= 0 ? '+' : ''}${b.value}`
                      : `${b.value >= 0 ? '+' : ''}${(b.value * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {result.unmodeled.length > 0 && (
        <section className="unmodeled-box">
          <h2>Not simulated ({result.unmodeled.length})</h2>
          <p className="hint">
            These picks are in your build but contribute nothing to the number above &mdash;
            their effect can&rsquo;t be expressed in the model.
          </p>
          <ul>
            {result.unmodeled.map((u) => (
              <li key={u.name}>{u.name}</li>
            ))}
          </ul>
        </section>
      )}

      {result.warnings.length > 0 && (
        <section className="warnings">
          <h2>Warnings</h2>
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
