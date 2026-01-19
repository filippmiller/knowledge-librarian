'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';

interface Domain {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  parentDomain: { slug: string; title: string } | null;
  childDomains: Array<{ slug: string; title: string }>;
  _count: {
    documents: number;
    rules: number;
    qaPairs: number;
  };
}

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDomains() {
      try {
        const response = await fetch('/api/domains');
        const data = await response.json();
        setDomains(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error('Error fetching domains:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchDomains();
  }, []);

  if (loading) {
    return <div className="text-center py-8">Loading...</div>;
  }

  // Group domains by parent for hierarchical display
  const rootDomains = domains.filter((d) => !d.parentDomain);
  const childDomainsByParent = domains.reduce(
    (acc, d) => {
      if (d.parentDomain) {
        const parentSlug = d.parentDomain.slug;
        if (!acc[parentSlug]) acc[parentSlug] = [];
        acc[parentSlug].push(d);
      }
      return acc;
    },
    {} as Record<string, Domain[]>
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Domains</h1>

      {domains.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No domains found. Run database seeding to create base domains.
          </CardContent>
        </Card>
      ) : (
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Documents</TableHead>
                <TableHead>Rules</TableHead>
                <TableHead>Q&A</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rootDomains.map((domain) => (
                <>
                  <TableRow key={domain.id} className="bg-gray-50">
                    <TableCell>
                      <code className="text-sm font-mono">{domain.slug}</code>
                    </TableCell>
                    <TableCell className="font-medium">{domain.title}</TableCell>
                    <TableCell className="text-sm text-gray-600">
                      {domain.description}
                    </TableCell>
                    <TableCell>{domain._count.documents}</TableCell>
                    <TableCell>{domain._count.rules}</TableCell>
                    <TableCell>{domain._count.qaPairs}</TableCell>
                  </TableRow>
                  {childDomainsByParent[domain.slug]?.map((child) => (
                    <TableRow key={child.id}>
                      <TableCell className="pl-8">
                        <code className="text-sm font-mono text-gray-600">
                          └ {child.slug}
                        </code>
                      </TableCell>
                      <TableCell>{child.title}</TableCell>
                      <TableCell className="text-sm text-gray-600">
                        {child.description}
                      </TableCell>
                      <TableCell>{child._count.documents}</TableCell>
                      <TableCell>{child._count.rules}</TableCell>
                      <TableCell>{child._count.qaPairs}</TableCell>
                    </TableRow>
                  ))}
                </>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
