const { onDocumentCreated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

// Initialize the Firebase Admin SDK
admin.initializeApp();

/**
 * This function triggers when a chapter document is deleted.
 * It uses the new v2 SDK syntax.
 */
exports.onDeleteChapter = onDocumentDeleted("books/{bookId}/chapters/{chapterId}", async (event) => {
    // Get the IDs from the path of the deleted document
    const { bookId, chapterId } = event.params;
    
    // Construct the path to the 'questions' subcollection
    const questionsPath = `books/${bookId}/chapters/${chapterId}/questions`;
    
    logger.log(`Starting to delete all questions in: ${questionsPath}`);

    const questionsCollection = admin.firestore().collection(questionsPath);
    await admin.firestore().recursiveDelete(questionsCollection);
    
    logger.log(`Successfully deleted all questions for chapter ${chapterId}.`);
});

/**
 * Automatically extracts a chapter number from a chapter's name when it's created.
 * This function already uses the correct v2 syntax.
 */
exports.addChapterNumber = onDocumentCreated("books/{bookId}/chapters/{chapterId}", async (event) => {
  const chapterData = event.data.data();

  if (chapterData.chapterNumber || !chapterData.name) {
    logger.log(`Chapter ${event.params.chapterId} already has a chapterNumber or has no name. Exiting.`);
    return null;
  }

  const match = chapterData.name.match(/\d+/);

  if (match) {
    const number = parseInt(match[0], 10);
    logger.log(`Found chapter number ${number} for chapter ${event.params.chapterId}.`);

    return event.data.ref.set({
      chapterNumber: number,
    }, { merge: true });
  } else {
    logger.warn(`Could not find a chapter number in the name: "${chapterData.name}".`);
    return null;
  }
});