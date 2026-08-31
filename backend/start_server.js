const { app } = require('./dist/index.js');
app.listen(5000, '0.0.0.0', () => console.log('Server running on port 5000'));
