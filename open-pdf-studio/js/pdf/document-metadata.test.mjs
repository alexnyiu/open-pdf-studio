import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  applyDocumentMetadataToPdf,
  assertDocumentMetadataRoundTrip,
  documentMetadataFieldFromEditorValue,
  documentMetadataFieldToEditorValue,
  documentMetadataFromPdfInfo,
  documentMetadataWithEditorField,
} from './document-metadata.js';

const metadata = {
  title: '設計図 – café',
  author: 'Ada Lovelace',
  subject: 'Round trip',
  keywords: 'alpha, beta; γ',
  creator: 'Open PDF Studio',
  producer: 'User supplied producer',
  creationDate: '2026-08-25T10:11:12.000Z',
  modificationDate: '2026-08-25T13:14:15.000Z',
};

test('Info metadata preserves Unicode, keywords, and exact second-precision dates', async () => {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage();
  applyDocumentMetadataToPdf(pdf, metadata);
  const reopened = await PDFDocument.load(await pdf.save(), { updateMetadata: false });
  assert.equal(reopened.getTitle(), metadata.title);
  assert.equal(reopened.getAuthor(), metadata.author);
  assert.equal(reopened.getKeywords(), metadata.keywords);
  assert.equal(reopened.getCreationDate().toISOString(), metadata.creationDate);
  assert.equal(reopened.getModificationDate().toISOString(), metadata.modificationDate);
});

test('empty values remove corresponding Info dictionary properties', async () => {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  applyDocumentMetadataToPdf(pdf, metadata);
  applyDocumentMetadataToPdf(pdf, {});
  const info = pdf.getInfoDict();
  for (const name of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
    assert.equal(info.has(PDFName.of(name)), false, name);
  }
});

test('existing XMP fields synchronize without removing unrelated namespaces', async () => {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const source = `<?xpacket begin="﻿"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:custom="urn:custom" pdf:Keywords="old" xmp:ModifyDate="2000-01-01T00:00:00Z" custom:keep="yes"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">old title</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>old author</rdf:li></rdf:Seq></dc:creator><dc:description><rdf:Alt><rdf:li xml:lang="x-default">old subject</rdf:li></rdf:Alt></dc:description><pdf:Producer>old producer</pdf:Producer></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const stream = pdf.context.stream(new TextEncoder().encode(source), { Type: 'Metadata', Subtype: 'XML' });
  pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(stream));
  applyDocumentMetadataToPdf(pdf, metadata);
  const raw = pdf.context.lookup(pdf.catalog.get(PDFName.of('Metadata')));
  assert.ok(raw instanceof PDFRawStream);
  const xml = new TextDecoder().decode(decodePDFRawStream(raw).decode());
  assert.match(xml, /custom:keep="yes"/u);
  assert.match(xml, /pdf:Keywords="alpha, beta; γ"/u);
  assert.match(xml, /<pdf:Producer>User supplied producer<\/pdf:Producer>/u);
  assert.match(xml, /<dc:title><rdf:Alt><rdf:li xml:lang="x-default">設計図 – café<\/rdf:li><\/rdf:Alt><\/dc:title>/u);
  assert.match(xml, /<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Round trip<\/rdf:li><\/rdf:Alt><\/dc:description>/u);
  assert.match(xml, /xmp:ModifyDate="2026-08-25T13:14:15\.000Z"/u);
  applyDocumentMetadataToPdf(pdf, {});
  const emptied = pdf.context.lookup(pdf.catalog.get(PDFName.of('Metadata')));
  const emptyXml = new TextDecoder().decode(decodePDFRawStream(emptied).decode());
  assert.match(emptyXml, /custom:keep="yes"/u);
  assert.doesNotMatch(emptyXml, /pdf:Keywords=/u);
  assert.doesNotMatch(emptyXml, /<pdf:Producer>/u);
  assert.doesNotMatch(emptyXml, /<dc:title>/u);
  assert.doesNotMatch(emptyXml, /<dc:description>/u);
});

test('PDF.js metadata validation reports an exact round trip', async () => {
  const info = {
    Title: metadata.title,
    Author: metadata.author,
    Subject: metadata.subject,
    Keywords: metadata.keywords,
    Creator: metadata.creator,
    Producer: metadata.producer,
    CreationDate: 'D:20260825101112Z',
    ModDate: 'D:20260825131415Z',
  };
  assert.deepEqual(documentMetadataFromPdfInfo(info), metadata);
  await assert.doesNotReject(assertDocumentMetadataRoundTrip({ getMetadata: async () => ({ info }) }, metadata));
});

test('inline editor values share exact string and local date conversion', () => {
  assert.equal(documentMetadataFieldToEditorValue('title', '  Exact title  '), '  Exact title  ');
  assert.equal(documentMetadataFieldFromEditorValue('keywords', 'alpha, beta'), 'alpha, beta');
  const local = documentMetadataFieldToEditorValue('creationDate', metadata.creationDate);
  assert.equal(documentMetadataFieldFromEditorValue('creationDate', local), metadata.creationDate);
  assert.throws(
    () => documentMetadataFieldFromEditorValue('modificationDate', 'not-a-date'),
    /Invalid modificationDate/u,
  );
  const cleared = documentMetadataWithEditorField(metadata, 'subject', '');
  assert.equal(cleared.subject, '');
  assert.equal(cleared.author, metadata.author);
});
