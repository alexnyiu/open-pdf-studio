import { createContext, useContext } from 'solid-js';

const ModalStackContext = createContext(null);

export function ModalStackProvider(props) {
  return (
    <ModalStackContext.Provider value={props.value}>
      {props.children}
    </ModalStackContext.Provider>
  );
}

export function useModalStack() {
  return useContext(ModalStackContext);
}
