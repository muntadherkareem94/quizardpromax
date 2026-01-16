const fs = require('fs');

// Path for the pulmonary file (handling the spaces in the name)
const filePath = './quizzes/brighammcq/pulmonary and critical care_brigham_review_output.json'; 

try {
    // 1. Check if file exists
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found at: ${filePath}`);
    }

    // 2. Read and Parse
    const rawData = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(rawData);

    // 3. Renumber starting from 51
    const START_NUMBER = 51;

    if (data.questions && Array.isArray(data.questions)) {
        data.questions.forEach((question, index) => {
            // index 0 becomes 51, index 1 becomes 52, etc.
            question.questionNumber = index + START_NUMBER; 
        });
        
        console.log(`Updated ${data.questions.length} questions. Numbering now starts at ${START_NUMBER}.`);
    } else {
        console.log('No "questions" array found.');
    }

    // 4. Save
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
    console.log('Success! Pulmonary file renumbered.');

} catch (error) {
    console.error('Error:', error.message);
}