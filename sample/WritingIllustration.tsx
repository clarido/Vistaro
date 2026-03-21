import styles from "./WritingIllustration.module.css";

interface WritingIllustrationProps {
  avatarLetter: string;
  modalTitle: string;
  modalStatus: string;
  originalLabel: string;
  adaptedLabel: string;
  originalText: string;
  adaptedSegments: { text: string; highlight?: boolean }[];
  originalCharCount: string;
  adaptedCharCount: string;
  lengthLabel: string;
  lengthShort: string;
  lengthMedium: string;
  lengthLong: string;
  regenerateBtn: string;
  approveBtn: string;
}

export function WritingIllustration(props: WritingIllustrationProps) {
  const {
    avatarLetter, modalTitle, modalStatus,
    originalLabel, adaptedLabel,
    originalText, adaptedSegments,
    originalCharCount, adaptedCharCount,
    lengthLabel, lengthShort, lengthMedium, lengthLong,
    regenerateBtn, approveBtn,
  } = props;

  return (
    <div className={styles.illustration} aria-hidden="true">
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.avatar}>{avatarLetter}</div>
        <div className={styles.headerText}>
          <div className={styles.modalTitle}>{modalTitle}</div>
          <div className={styles.modalStatus}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            {modalStatus}
          </div>
        </div>
        <div className={styles.closeBtn}>✕</div>
      </div>

      {/* Split panes */}
      <div className={styles.split}>
        {/* Left: original */}
        <div className={styles.pane}>
          <div className={`${styles.paneLabel} ${styles.paneLabelOriginal}`}>{originalLabel}</div>
          <div className={styles.paneBox}>
            <div className={styles.bioText}>{originalText}</div>
            <div className={`${styles.paneFade} ${styles.paneFadeOriginal}`} />
          </div>
          <div className={styles.charCount}>{originalCharCount}</div>
        </div>

        {/* Right: adapted */}
        <div className={styles.pane}>
          <div className={`${styles.paneLabel} ${styles.paneLabelAdapted}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M18 14l.5 1.5L20 16l-1.5.5L18 18l-.5-1.5L16 16l1.5-.5z"/></svg>
            {adaptedLabel}
          </div>
          <div className={`${styles.paneBox} ${styles.paneBoxAdapted}`}>
            <div className={styles.bioText}>
              {adaptedSegments.map((seg, i) =>
                seg.highlight ? (
                  <span key={i} className={styles.highlight}>{seg.text}</span>
                ) : (
                  <span key={i}>{seg.text}</span>
                )
              )}
            </div>
            <div className={`${styles.paneFade} ${styles.paneFadeAdapted}`} />
          </div>
          <div className={styles.charCount}>{adaptedCharCount}</div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className={styles.bottomBar}>
        <div className={styles.lengthSelector}>
          <span className={styles.lengthLabel}>{lengthLabel}</span>
          <div className={styles.lengthBtn}>{lengthShort}</div>
          <div className={styles.lengthBtn}>{lengthMedium}</div>
          <div className={`${styles.lengthBtn} ${styles.lengthBtnActive}`}>{lengthLong}</div>
        </div>
        <div className={styles.actions}>
          <div className={styles.btnRegen}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            {regenerateBtn}
          </div>
          <div className={styles.btnApprove}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            {approveBtn}
          </div>
        </div>
      </div>
    </div>
  );
}
