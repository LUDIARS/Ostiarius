// C-17 resolveAllowedOrigin(origin, allowlist)
//
// CORS で返す origin は allowlist に完全一致したものだけ。ワイルドカードは返さない。

export default {
  post: (result: string | null, origin: string | undefined, allowlist: readonly string[]) => {
    if (result === '*') return 'a wildcard origin must never be allowed';
    // '*' と 'null' は allowlist に紛れ込んでいても origin として認めない。
    const allowable = Boolean(origin && origin !== '*' && origin !== 'null' && allowlist.includes(origin));
    if (result === null) return !allowable || 'an allow-listed origin was rejected';
    return (result === origin && allowlist.includes(result)) || 'only an exact allow-listed origin may be echoed';
  },
};
