import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          AI Knowledge Librarian
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Living knowledge library for your translation bureau.
          Upload documents, extract rules, and ask questions.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/playground"
            className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
          >
            Try Playground
          </Link>
          <Link
            href="/admin"
            className="inline-flex items-center justify-center px-6 py-3 border border-gray-300 text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 transition-colors"
          >
            Admin Panel
          </Link>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-8 text-left">
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Upload Documents</h3>
            <p className="text-sm text-gray-600">
              Upload PDF, DOCX, or TXT files. AI automatically extracts rules and Q&A pairs.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Domain Classification</h3>
            <p className="text-sm text-gray-600">
              AI classifies knowledge into domains and suggests new categories when needed.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Ask Questions</h3>
            <p className="text-sm text-gray-600">
              Query your knowledge base. Get answers with citations and confidence scores.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
