// Script to check staged extraction data structure
import prisma from '../src/lib/db';

async function checkStagedData() {
  try {
    // Get the most recent document
    const latestDoc = await prisma.document.findFirst({
      orderBy: { uploadedAt: 'desc' },
      select: { id: true, title: true }
    });

    if (!latestDoc) {
      console.log('No documents found');
      return;
    }

    console.log(`\n=== Checking staged data for document: ${latestDoc.title} ===\n`);

    // Get staged extractions
    const staged = await prisma.stagedExtraction.findMany({
      where: { documentId: latestDoc.id },
      select: {
        id: true,
        itemType: true,
        data: true,
        isVerified: true
      },
      take: 10
    });

    console.log(`Found ${staged.length} staged items\n`);

    for (const item of staged) {
      console.log(`\n--- Item Type: ${item.itemType} (Verified: ${item.isVerified}) ---`);
      console.log('Data structure:');
      console.log(JSON.stringify(item.data, null, 2));

      // Check for missing or wrong fields
      if (item.itemType === 'QA_PAIR') {
        const data = item.data as any;
        console.log('\nQA_PAIR field check:');
        console.log('  has question:', 'question' in data);
        console.log('  has answer:', 'answer' in data);
        console.log('  has linkedRuleCode:', 'linkedRuleCode' in data);
      }

      if (item.itemType === 'CHUNK') {
        const data = item.data as any;
        console.log('\nCHUNK field check:');
        console.log('  has index:', 'index' in data);
        console.log('  has content:', 'content' in data);
        console.log('  has metadata:', 'metadata' in data);
        if (data.metadata) {
          console.log('  metadata has startChar:', 'startChar' in data.metadata);
          console.log('  metadata has endChar:', 'endChar' in data.metadata);
        }
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkStagedData();
