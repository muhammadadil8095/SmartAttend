import PDFDocument from 'pdfkit';

/**
 * Generates a styled, paginated PDF table document buffer.
 * 
 * @param {Object} options
 * @param {string} options.title - Document Title
 * @param {string} options.subtitle - Subtitle / Metadata
 * @param {Array<{ label: string, width: number }>} options.columns - Column definitions
 * @param {Array<Array<string>>} options.rows - Row data matching columns
 * @param {string} [options.orientation='portrait'] - 'portrait' or 'landscape'
 * @returns {Promise<Buffer>}
 */
export function generatePdfTableBuffer({
  title,
  subtitle,
  columns,
  rows,
  orientation = 'portrait',
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 36,
      size: 'A4',
      layout: orientation,
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const contentWidth = pageWidth - 72; // margins left + right
    const rowHeight = 20;

    // Draw document header
    function drawDocHeader() {
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f172a').text(title, 36, 36);
      if (subtitle) {
        doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(subtitle, 36, 56);
      }
      doc.moveDown(1);
    }

    // Draw table header row
    function drawTableHeader(y) {
      doc.rect(36, y, contentWidth, rowHeight).fill('#f1f5f9');
      doc.fillColor('#334155').fontSize(9).font('Helvetica-Bold');

      let currentX = 42;
      for (const col of columns) {
        doc.text(col.label, currentX, y + 5, {
          width: col.width - 8,
          ellipsis: true,
        });
        currentX += col.width;
      }
    }

    drawDocHeader();
    let currentY = 78;
    drawTableHeader(currentY);
    currentY += rowHeight;

    doc.font('Helvetica').fontSize(8.5);

    for (let i = 0; i < rows.length; i++) {
      // Check for page break
      if (currentY + rowHeight > pageHeight - 45) {
        doc.addPage();
        currentY = 36;
        drawTableHeader(currentY);
        currentY += rowHeight;
        doc.font('Helvetica').fontSize(8.5);
      }

      // Alternating row background
      if (i % 2 === 1) {
        doc.rect(36, currentY, contentWidth, rowHeight).fill('#f8fafc');
      }

      let currentX = 42;
      for (let c = 0; c < columns.length; c++) {
        const textVal = String(rows[i][c] ?? '');
        doc.fillColor(c === 0 ? '#0f172a' : '#475569');
        doc.text(textVal, currentX, currentY + 5, {
          width: columns[c].width - 8,
          ellipsis: true,
        });
        currentX += columns[c].width;
      }

      currentY += rowHeight;
    }

    // Footer with page numbering on all pages
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8').text(
        `Page ${i + 1} of ${range.count} | SmartAttend Academic Records`,
        36,
        pageHeight - 25,
        { align: 'center', width: contentWidth }
      );
    }

    doc.end();
  });
}
