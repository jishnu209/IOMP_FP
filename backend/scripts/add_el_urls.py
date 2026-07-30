"""
Adds el_url column and updates all 78 topics with their EL source URLs.
Run: python add_el_urls.py
"""
import os, psycopg2
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent.parent / ".env")
DB = os.getenv("DATABASE_URL","postgresql://postgres:nexus123@localhost:5432/nexus")

# (module_id, topic_order) -> el_url
EL_URLS = {
(1,1):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/intro-to-platform/a-customer-experience-powered-by-experience-platform.html",
(1,2):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/intro-to-platform/overview.html",
(1,3):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/intro-to-platform/basic-architecture.html",
(1,4):"https://experienceleague.adobe.com/en/docs/experience-platform/landing/platform-apis/api-authentication",
(1,5):"https://experienceleague.adobe.com/en/docs/experience-platform/sandbox/home",
(1,6):"https://experienceleague.adobe.com/en/docs/experience-platform/rtcdp/intro/rtcdp-intro/overview",
(1,7):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/sources/overview",
(1,8):"https://experienceleague.adobe.com/en/docs/experience-platform/data-governance/home",
(1,9):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/understanding-the-real-time-customer-profile",
(1,10):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/create-audiences",
(1,11):"https://experienceleague.adobe.com/en/docs/experience-platform/query/home",
(2,1):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/sources/ingest-data-from-adobe-analytics.html",
(2,2):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/sources/ingest-data-from-aam.html",
(2,3):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/sources/ingest-data-from-cloud-storage.html",
(2,4):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/sources/ingest-data-from-crm.html",
(2,5):"https://experienceleague.adobe.com/docs/platform-learn/tutorials/sources/ingest-data-from-databases.html",
(2,6):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/identities/understanding-identity-and-identity-graphs",
(2,7):"https://experienceleague.adobe.com/en/docs/experience-platform/identity/home",
(3,1):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/understanding-the-real-time-customer-profile",
(3,2):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/overview-diagram",
(3,3):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/bring-data-into-the-real-time-customer-profile",
(3,4):"https://experienceleague.adobe.com/en/docs/experience-platform/profile/ui/profile-customization",
(3,5):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/view-account-profiles",
(3,6):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/create-merge-policies",
(3,7):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/union-schemas-overview",
(4,1):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/audience-rule-builder-overview",
(4,2):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/audience-rule-builder-overview",
(4,3):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/create-audiences",
(4,4):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/home",
(4,5):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/create-content-based-audiences",
(4,6):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/create-conversion-audiences",
(4,7):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/create-audiences-from-existing-audiences",
(4,8):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/tutorials/create-a-dynamic-segment",
(4,9):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/create-sequential-audiences",
(4,10):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/tutorials/multi-entity-segmentation",
(4,11):"https://experienceleague.adobe.com/en/docs/experience-platform/rtcdp/segmentation/b2b",
(4,12):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/tutorials/evaluate-a-segment",
(4,13):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/tutorials/create-a-segment",
(4,14):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/ui/audience-portal",
(4,15):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/ui/audience-portal#flexible-audience-evaluation",
(4,16):"https://experienceleague.adobe.com/en/docs/experience-platform/catalog/datasets/experience-event-dataset-retention-ttl-guide",
(4,17):"https://experienceleague.adobe.com/en/docs/experience-platform/profile/guardrails",
(5,1):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/understanding-destinations",
(5,2):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/connecting-to-destinations",
(5,3):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/activate-profiles-and-segments-to-a-destination",
(5,4):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/configure-dataset-export-destination",
(5,5):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/configure-the-azure-blob-destination",
(5,6):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/target/next-hit-personalization",
(5,7):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/integrate-with-google-customer-match",
(5,8):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/configure-the-marketo-destination",
(5,9):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/configure-a-social-destination",
(5,10):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/activate-data-to-non-adobe-applications",
(5,11):"https://experienceleague.adobe.com/en/docs/experience-platform/tags/event-forwarding/overview",
(6,1):"https://experienceleague.adobe.com/en/docs/experience-platform/dataflows/ui/monitor",
(6,2):"https://experienceleague.adobe.com/en/docs/experience-platform/ingestion/quality/monitor-data-ingestion",
(6,3):"https://experienceleague.adobe.com/en/docs/experience-platform/ingestion/quality/monitor-data-ingestion",
(6,4):"https://experienceleague.adobe.com/en/docs/experience-platform/dataflows/ui/monitor-sources",
(6,5):"https://experienceleague.adobe.com/en/docs/experience-platform/dataflows/ui/monitor-streaming-profile",
(6,6):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/monitoring/monitoring-dashboard",
(6,7):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/monitoring/monitoring-dashboard",
(6,8):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/monitoring/monitoring-the-success-of-segment-activation",
(6,9):"https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/monitoring/data-monitoring",
(7,1):"https://experienceleague.adobe.com/en/docs/experience-platform/federated-audience-composition/home",
(7,2):"https://experienceleague.adobe.com/en/docs/experience-platform/ai-assistant/home",
(7,3):"https://experienceleague.adobe.com/en/docs/experience-platform/ai-assistant/home",
(7,4):"https://experienceleague.adobe.com/en/docs/experience-platform/intelligent-services/customer-ai/overview",
(7,5):"https://experienceleague.adobe.com/en/docs/experience-platform/profile/computed-attributes/overview",
(7,6):"https://experienceleague.adobe.com/en/docs/experience-platform/rtcdp/segmentation/customer-ai",
(7,7):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/ui/audience-portal",
(7,8):"https://experienceleague.adobe.com/en/docs/experience-platform/use-case-playbooks/playbooks/overview",
(7,9):"https://experienceleague.adobe.com/en/docs/experience-platform/rtcdp/partner-data/prospecting",
(7,10):"https://experienceleague.adobe.com/en/docs/experience-platform/rtcdp/ai-customer-data-management/audience-agent",
(8,1):"https://experienceleague.adobe.com/en/docs/experience-platform/query/home",
(8,2):"https://experienceleague.adobe.com/en/docs/experience-platform/profile/troubleshooting",
(8,3):"https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/troubleshooting",
(8,4):"https://experienceleague.adobe.com/en/docs/experience-platform/sandbox/home",
(8,5):"https://experienceleague.adobe.com/en/docs/experience-platform/profile/home",
(9,1):"https://experienceleague.adobe.com/en/docs/certification/program/technical-certifications/aep/aq-rtcdp-p-business-practitioner",
}

conn = psycopg2.connect(DB)
cur = conn.cursor()

# Add column if not exists
cur.execute("ALTER TABLE curriculum_topics ADD COLUMN IF NOT EXISTS el_url TEXT")

# Update each topic
updated = 0
for (mod, order), url in EL_URLS.items():
    cur.execute(
        "UPDATE curriculum_topics SET el_url=%s WHERE module_id=%s AND topic_order=%s",
        (url, mod, order)
    )
    updated += cur.rowcount

conn.commit()
cur.close()
conn.close()
print(f"Updated {updated} topics with EL URLs")
