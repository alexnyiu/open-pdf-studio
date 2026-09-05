import { createSignal } from 'solid-js';

const [visible, setVisible] = createSignal(false);
const [message, setMessage] = createSignal('Loading...');
const [documentId, setDocumentId] = createSignal(null);

export { visible, setVisible, message, setMessage, documentId, setDocumentId };
