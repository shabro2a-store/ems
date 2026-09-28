/**
 * What a receipt photo must be, shared by the server (receiptImage.ts) and
 * the driver's camera, which checks before the photo is used rather than
 * after an upload the server refuses.
 */
export const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The short side is what the receipt's width lands on in portrait. Below this
 * the print is a smear, and the automated reader the owner wants later would
 * have nothing to read - the photos are kept for that as much as for him.
 */
export const RECEIPT_MIN_SHORT_SIDE = 480;
