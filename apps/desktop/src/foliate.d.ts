declare module 'foliate-js/view.js' {
    export class View extends HTMLElement {
        open(book: any): Promise<void>;
        close(): void;
    }
}

declare module 'foliate-js/epub.js' {
    export class EPUB {
        constructor(loader: any);
        init(): Promise<void>;
    }
}
