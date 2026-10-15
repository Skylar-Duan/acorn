/** 本机读取与云端恢复共用的等待页；只显示真实等待，不人为拖慢启动。 */
export default function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="center-note loading-screen" role="status" aria-live="polite">
      <div className="loading-emblem" aria-hidden="true">
        <span className="loading-orbit" />
        <svg viewBox="0 0 48 48" fill="none">
          <path d="M14 23c0 13 7 18 10 20 3-2 10-7 10-20" stroke="currentColor" strokeWidth="1.8" />
          <path d="M11 22c0-7 6-11 13-11s13 4 13 11H11Z" fill="currentColor" opacity=".18" />
          <path d="M11 22c0-7 6-11 13-11s13 4 13 11H11Zm13-11c0-5 3-8 7-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <span className="big">橡果</span>
      <span className="loading-copy">{message}</span>
      <div className="loading-lines" aria-hidden="true"><i /><i /><i /></div>
    </div>
  );
}
