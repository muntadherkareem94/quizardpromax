const fs = require('fs');

// Make sure this matches your file name exactly
const filePath = './board_practice_all_with_answers.json'; 

try {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const rawData = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(rawData);

    if (data.questions && Array.isArray(data.questions)) {
        data.questions.forEach((question, index) => {
            // We want 1, 2, 3...
            const num = index + 1; 

            // Update Question Image URL: .../ch10/q/10.1.png, 10.2.png...
            question.imageUrl = `images/books-images/brigham/ch10/q/10.${num}.png`;

            // Update Explanation Image URL: .../ch10/a/10.1.png, 10.2.png...
            // (I corrected 'ch1' to 'ch10' here to match the file numbering)
            question.explanationImageUrl = `images/books-images/brigham/ch10/a/10.${num}.png`;
        });
        
        console.log(`Updated images paths for ${data.questions.length} questions.`);
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
    console.log('Success! Image paths updated.');

} catch (error) {
    console.error('Error:', error.message);
}