"""Benchmark PDF MCQ extraction locally without any API key or network access.

Examples:
  python local_benchmark.py C:\books\test_book.pdf
  python local_benchmark.py C:\books --json-report C:\books\benchmark.json
This does NOT publish the books and does NOT call AI.
"""
import argparse
import json
import sys
from pathlib import Path

import fitz
from local_mcq import extract_local_section, local_book_metadata


def benchmark(path: Path) -> dict:
    with fitz.open(path) as pdf:
        if pdf.needs_pass:
            return {"file":path.name,"eligible":False,"issue":"PDF is password-protected"}
        result=extract_local_section(pdf,1,len(pdf))
        metadata=local_book_metadata(pdf)
        return {
            "file":path.name,
            "pages":len(pdf),
            "questions":len(result["questions"]),
            "locally_validated":result["strict_pass"],
            "source_issue_count":len(result["issues"]),
            "source_issues":result["issues"],
            "question_image_count":sum(q["figureInQuestion"] for q in result["questions"]),
            "explanation_image_count":sum(q["figureInExplanation"] for q in result["questions"]),
            "cover_title_matched":metadata is not None,
            "extraction_milliseconds":result["elapsed_ms"],
            "AI_requests":0,
        }


def main():
    parser=argparse.ArgumentParser(description="Quizard zero-token PDF import benchmark")
    parser.add_argument("paths",nargs="+",help="PDF files or directories containing PDFs")
    parser.add_argument("--json-report",help="Save JSON benchmark report to this path")
    args=parser.parse_args()
    paths=[]
    for name in args.paths:
        p=Path(name)
        if p.is_file() and p.suffix.lower()==".pdf":
            paths.append(p)
        elif p.is_dir():
            paths.extend(sorted(x for x in p.glob("*.pdf") if x.is_file()))
        else:
            print(f"Skipped non-PDF or unavailable path: {p}",file=sys.stderr)
    if not paths:
        parser.error("No PDFs found")
    results=[]
    for path in paths:
        try: result=benchmark(path)
        except Exception as exc:
            result={"file":path.name,"locally_validated":False,
                    "source_issue_count":1,"error":str(exc),"AI_requests":0}
        results.append(result)
        print(
            f"{'PASS' if result.get('locally_validated') else 'FALLBACK'}  "
            f"{path.name}: {result.get('pages','?')} pages, "
            f"{result.get('questions','?')} questions, "
            f"{result.get('extraction_milliseconds','?')} ms, "
            f"{result.get('source_issue_count','?')} issues"
        )
    if args.json_report:
        report=Path(args.json_report)
        report.parent.mkdir(parents=True,exist_ok=True)
        report.write_text(json.dumps(results,indent=2,ensure_ascii=False),encoding="utf-8")
        print(f"Benchmark saved to {report}")
    print(f"{sum(r.get('locally_validated') is True for r in results)}/{len(results)} "
          "books eligible for strict local import, 0 AI calls")


if __name__=="__main__":
    main()
