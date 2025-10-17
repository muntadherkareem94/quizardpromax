const fs = require('fs');
const path = require('path');

const quizzesRoot = path.join(__dirname, 'quizzes');

console.log('Starting to process all book folders in "quizzes/"...');

try {
    // Get all book folders inside the main 'quizzes' directory
    const bookFolders = fs.readdirSync(quizzesRoot, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    for (const bookFolder of bookFolders) {
        const bookPath = path.join(quizzesRoot, bookFolder);
        
        // Get all JSON files inside the specific book folder
        const chapterFiles = fs.readdirSync(bookPath)
            .filter(file => path.extname(file).toLowerCase() === '.json');

        for (const chapterFile of chapterFiles) {
            const filePath = path.join(bookPath, chapterFile);
            
            // Read the file, add numbers, and write it back
            const fileData = fs.readFileSync(filePath, 'utf8');
            const quizData = JSON.parse(fileData);

            if (quizData.questions && Array.isArray(quizData.questions)) {
                quizData.questions.forEach((question, index) => {
                    question.questionNumber = index + 1;
                });
            }

            const updatedData = JSON.stringify(quizData, null, 2);
            fs.writeFileSync(filePath, updatedData, 'utf8');
            console.log(`Successfully processed: ${bookFolder}/${chapterFile}`);
        }
    }
    console.log('All files have been updated successfully!');
} catch (error) {
    console.error('An error occurred:', error);
    console.error('Please ensure the "quizzes" directory exists and contains book folders as described.');
}