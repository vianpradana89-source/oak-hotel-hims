import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles.css'
import App from './App.tsx'

// Global auto-uppercase for operational HIMS text inputs (excluding login/email/password/template fields)
if (typeof document !== 'undefined') {
  const inputValSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  const textareaValSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  document.addEventListener(
    'input',
    (e: Event) => {
      const target = e.target;
      if (
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      if (target.dataset.noUppercase === 'true' || target.readOnly || target.disabled) {
        return;
      }

      if (target instanceof HTMLInputElement) {
        const t = (target.type || 'text').toLowerCase();
        if (t !== 'text') return;
        const inputMode = (target.inputMode || '').toLowerCase();
        if (inputMode === 'numeric' || inputMode === 'decimal') return;
      }

      const nameAndPlaceholder = [
        target.name || '',
        target.id || '',
        target.autocomplete || '',
        target.placeholder || '',
      ]
        .join(' ')
        .toLowerCase();

      if (
        nameAndPlaceholder.includes('email') ||
        nameAndPlaceholder.includes('password') ||
        nameAndPlaceholder.includes('username') ||
        nameAndPlaceholder.includes('kata sandi') ||
        nameAndPlaceholder.includes('http') ||
        nameAndPlaceholder.includes('{nama}')
      ) {
        return;
      }

      const currentVal = target.value;
      if (!currentVal) return;
      const upperVal = currentVal.toUpperCase();
      if (upperVal === currentVal) return;

      const start = target.selectionStart;
      const end = target.selectionEnd;

      if (target instanceof HTMLInputElement && inputValSetter) {
        inputValSetter.call(target, upperVal);
      } else if (target instanceof HTMLTextAreaElement && textareaValSetter) {
        textareaValSetter.call(target, upperVal);
      } else {
        target.value = upperVal;
      }

      try {
        if (start !== null && end !== null) {
          target.setSelectionRange(start, end);
        }
      } catch {
        // Ignore selection range errors on unsupported input types
      }
    },
    true
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
