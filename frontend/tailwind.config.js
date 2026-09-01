/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      fontSize: {
        'oak-page': ['1.5rem', { lineHeight: '1.3', fontWeight: '700' }],
        'oak-section': ['1.125rem', { lineHeight: '1.35', fontWeight: '600' }],
        'oak-card': ['1rem', { lineHeight: '1.4', fontWeight: '600' }],
        'oak-body': ['0.875rem', { lineHeight: '1.5', fontWeight: '400' }],
        'oak-label': ['0.8125rem', { lineHeight: '1.4', fontWeight: '500' }],
        'oak-input': ['0.875rem', { lineHeight: '1.4', fontWeight: '400' }],
        'oak-button': ['0.875rem', { lineHeight: '1', fontWeight: '600' }],
        'oak-th': ['0.8125rem', { lineHeight: '1', fontWeight: '600' }],
        'oak-td': ['0.875rem', { lineHeight: '1.5', fontWeight: '400' }],
        'oak-caption': ['0.75rem', { lineHeight: '1.4', fontWeight: '400' }],
        'oak-badge': ['0.75rem', { lineHeight: '1', fontWeight: '600' }],
      },
    },
  },
  plugins: [],
}