// Import the Firebase Admin SDK
const admin = require('firebase-admin');

// Import your service account key
const serviceAccount = require('./serviceAccountKey.json');

// Initialize the app with your project's credentials
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

async function migrateQuestions() {
  console.log('Starting migration...');

  // Get all the book documents
  const booksSnapshot = await db.collection('books').get();

  // Create a list of all update promises
  const allUpdatePromises = [];

  for (const bookDoc of booksSnapshot.docs) {
    const bookId = bookDoc.id;
    console.log(`-> Processing book: ${bookDoc.data().title}`);

    // Get all chapters for this book
    const chaptersSnapshot = await bookDoc.ref.collection('chapters').get();

    for (const chapterDoc of chaptersSnapshot.docs) {
      const chapterData = chapterDoc.data();
      const correctChapterNumber = chapterData.chapterNumber;

      if (typeof correctChapterNumber === 'undefined') {
        console.warn(`  - WARNING: Chapter ${chapterData.name} is missing a chapterNumber. Skipping its questions.`);
        continue;
      }
      
      // Get all questions for this chapter
      const questionsSnapshot = await chapterDoc.ref.collection('questions').get();
      
      for (const questionDoc of questionsSnapshot.docs) {
        const questionData = questionDoc.data();

        // Check if the chapterNumber field is missing from the question
        if (typeof questionData.chapterNumber === 'undefined') {
          console.log(`  - Updating Question #${questionData.questionNumber} in Chapter ${correctChapterNumber}...`);
          // Add the update operation to our list of promises
          const updatePromise = questionDoc.ref.update({
            chapterNumber: correctChapterNumber
          });
          allUpdatePromises.push(updatePromise);
        }
      }
    }
  }

  // Wait for all the updates to complete
  await Promise.all(allUpdatePromises);
  
  if (allUpdatePromises.length > 0) {
    console.log(`\nMigration complete! Successfully updated ${allUpdatePromises.length} questions.`);
  } else {
    console.log('\nMigration complete! All questions were already in the correct format.');
  }
}

// Run the migration function
migrateQuestions();